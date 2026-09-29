/**
 * Who may see a ticket, and what they may do to it.
 *
 * This file exists because the rule is needed in at least a dozen places --
 * the list query, the detail query, every mutation, the portlets, the
 * notification fan-out -- and a rule written a dozen times is a rule that will
 * disagree with itself within a month. Every one of those places calls in
 * here. Nothing re-derives it.
 *
 * The model, in one paragraph. Visibility is per TICKET, not per department:
 * `tk_participants` IS the access list, plus the managers of the target
 * department and anyone above it in the tree. A ticket with no contributors is
 * invisible to the rest of the department, which is the whole of the
 * confidentiality story -- confidentiality from your colleagues, not from the
 * management chain above you.
 *
 * Capability then narrows visibility by role AND by status. The title and
 * description belong to the requester for ever: they are the record of what
 * was asked, and an assignee who could rewrite them would leave nobody able to
 * say what the original request was.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Principal, can } from '../../common/auth';
import { one, query } from '../../common/db';
import { TASK_PERMISSIONS } from './permissions';

export type ParticipantRole =
  | 'REQUESTER' | 'ASSIGNEE' | 'CONTRIBUTOR' | 'PAST_ASSIGNEE' | 'OBSERVER';

export type TaskStatus =
  | 'NEW' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED'
  | 'RESOLVED' | 'CLOSED' | 'REJECTED' | 'CANCELLED';

/** Nothing moves from here except reopening, and only from CLOSED. */
const TERMINAL: TaskStatus[] = ['CLOSED', 'REJECTED', 'CANCELLED'];
/** Somebody owns it and the work is live. */
const LIVE: TaskStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'BLOCKED'];

export interface TaskRowForAccess {
  id: string;
  status: TaskStatus;
  requester_id: string;
  assignee_id: string | null;
  department_id: string;
  requester_department_id: string | null;
}

export interface TaskAccess {
  /** Roles this person holds on this ticket. Can be more than one: a ticket
   *  you raise for yourself makes you REQUESTER and ASSIGNEE at once. */
  roles: ParticipantRole[];
  /** Runs the department the work was asked OF. This is the one that carries
   *  authority: assigning, redirecting, refusing. */
  managesDepartment: boolean;
  /** Runs the department the work was asked BY. Reads and comments, and
   *  nothing more -- overseeing your own people's requests is not the same as
   *  deciding how another department does its work. */
  managesRequestingDepartment: boolean;
  isRequester: boolean;
  isAssignee: boolean;

  /** Title, description, priority, target department. Requester only, and
   *  only while nobody has picked it up -- after that the request is a fixed
   *  point and a change of mind is a comment or a new ticket. */
  canEditRequest: boolean;
  canCancel: boolean;
  /** Give it to somebody, or take it off them and give it to somebody else. */
  canAssign: boolean;
  /** Send it to a different department entirely. */
  canTransfer: boolean;
  /** Refuse it outright. Only before accepting it -- once assigned, the honest
   *  moves are transfer or resolve, not rejection. */
  canReject: boolean;
  canManageContributors: boolean;
  /** Status, due date. The assignee's own work. */
  canWork: boolean;
  /**
   * Ask another department for something this ticket needs.
   *
   * Wider than canWork on purpose: a manager watching their department's work
   * knows before the assignee does that Facilities will have to be involved,
   * and making them message the assignee to click a button is a step that adds
   * nothing. Requires somebody to be on the ticket, because a dependency on an
   * unassigned ticket has nobody to receive the answer -- and because BLOCKED
   * with no assignee is a state the database refuses.
   */
  canAddDependency: boolean;
  canResolve: boolean;
  /** The requester accepting or refusing the resolution. */
  canConfirmResolution: boolean;
  canReopen: boolean;
  canComment: boolean;
}

/**
 * A SQL predicate for "tickets this person may see", for use in any list
 * query. Returns the fragment and the parameters it needs, numbered from
 * `startIndex`.
 *
 * `requester_id` and `assignee_id` are tested directly even though both are
 * always in tk_participants. The redundancy is deliberate and costs nothing:
 * a bug that failed to write a participant row would otherwise hide a ticket
 * from the person who raised it, which is the worst failure this module has.
 */
export function visibilityFilter(
  p: Principal, alias = 't', startIndex = 1,
): { sql: string; params: any[] } {
  const seesEverything = can(p, TASK_PERMISSIONS.VIEW_ANY) || can(p, TASK_PERMISSIONS.MANAGE_ANY);
  const i = startIndex;
  return {
    sql: `(
      $${i + 2}::boolean
      OR ${alias}.requester_id  = $${i}::uuid
      OR ${alias}.assignee_id   = $${i}::uuid
      OR ${alias}.department_id = ANY($${i + 1}::uuid[])
      /* The department that ASKED, not only the one that was asked. A manager
         is answerable for what their people request as well as for what lands
         on their desk -- Dina's manager could not see the ticket Dina raised,
         which is the wrong way round in any company. Snapshotted on the row at
         creation, so a ticket does not change hands when somebody transfers
         between departments. */
      OR ${alias}.requester_department_id = ANY($${i + 1}::uuid[])
      OR EXISTS (SELECT 1 FROM tk_participants pp
                  WHERE pp.item_id = ${alias}.id AND pp.user_id = $${i}::uuid)
      OR EXISTS (
           /* The people answerable for a blocked ticket can see what is
              blocking it. Without this, a manager who raises the dependency
              becomes its requester and the assignee -- the person actually
              stuck -- can see only the summary strip, which is the wrong way
              round. Scoped to the assignee and the managers of the blocked
              ticket's department: the original requester still gets the strip
              and nothing more, because the blocking work is not theirs. */
           SELECT 1 FROM tk_links dl
             JOIN tk_items dp ON dp.id = dl.item_id
            WHERE dl.depends_on_item_id = ${alias}.id
              AND dl.link_type = 'BLOCKED_BY'
              AND (dp.assignee_id = $${i}::uuid OR dp.department_id = ANY($${i + 1}::uuid[]))
         )
    )`,
    params: [p.id, p.managedDepartmentIds ?? [], seesEverything],
  };
}

/** What this person may do to this ticket, given the roles they hold on it. */
export function accessFor(
  p: Principal, item: TaskRowForAccess, roles: ParticipantRole[],
): TaskAccess {
  const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY);
  const managed = p.managedDepartmentIds ?? [];
  const managesDepartment = manageAny || managed.includes(item.department_id);
  const managesRequestingDepartment = manageAny
    || (!!item.requester_department_id && managed.includes(item.requester_department_id));

  const isRequester = item.requester_id === p.id;
  const isAssignee = !!item.assignee_id && item.assignee_id === p.id;
  const involved = roles.length > 0 || isRequester || isAssignee
    || managesDepartment || managesRequestingDepartment;

  const status = item.status;
  const open = !TERMINAL.includes(status);
  const live = LIVE.includes(status);

  return {
    roles, managesDepartment, managesRequestingDepartment, isRequester, isAssignee,

    /* manage-any replaces the IDENTITY check, never the STATUS check. It means
       "I may act in any department", not "I may act in any state" -- and
       putting it in front of the whole condition, as this originally did, left
       an administrator looking at Accept, Send back and Cancel on a ticket
       that had been closed a week earlier. A finished ticket has no actions
       for anybody. */
    canEditRequest: (isRequester || manageAny) && status === 'NEW',
    canCancel: (isRequester || manageAny) && open && status !== 'RESOLVED',

    canAssign: (managesDepartment || manageAny) && (status === 'NEW' || live),
    /* Transfer moves the whole ticket to another department and clears the
       assignee. Allowed while the work is live because the wrong department is
       sometimes only obvious once somebody starts -- but if the ticket merely
       NEEDS something from elsewhere, the answer is a dependency, which leaves
       this department still owning the request. */
    canTransfer: (managesDepartment || manageAny)
      && (status === 'NEW' || status === 'ASSIGNED' || status === 'IN_PROGRESS'),
    canReject: (managesDepartment || manageAny) && status === 'NEW',
    canManageContributors: (managesDepartment || manageAny) && open,

    canWork: (isAssignee || manageAny) && live,
    canAddDependency: (isAssignee || managesDepartment || manageAny) && live,
    /* Not while BLOCKED: the API refuses it anyway, and offering a button that
       is going to be refused is worse than not offering it. */
    canResolve: (isAssignee || manageAny) && (status === 'ASSIGNED' || status === 'IN_PROGRESS'),

    canConfirmResolution: (isRequester || manageAny) && status === 'RESOLVED',
    canReopen: (isRequester || managesDepartment || manageAny) && status === 'CLOSED',

    /* Everyone who can see it can say something about it, except the manager
       who transferred it away -- they kept read access to answer for where it
       went, not to keep steering it. */
    canComment: involved && open
      && !(roles.length === 1 && roles[0] === 'OBSERVER'
           && !isRequester && !isAssignee && !managesDepartment && !managesRequestingDepartment),
  };
}

/**
 * Load a ticket and the caller's access to it in one place, so no route can
 * forget the check. Throws 404 rather than 403 when the ticket is invisible:
 * a person who may not see a ticket should not learn that it exists.
 */
export async function loadWithAccess(
  p: Principal, itemId: string,
): Promise<{ item: TaskRowForAccess; access: TaskAccess }> {
  /* The same predicate the list queries use, rather than a second version of
     the rule written out longhand here. Two spellings of one rule is how a
     ticket ends up visible in a list and 404 when opened. */
  const vis = visibilityFilter(p, 't', 1);
  const item = await one<TaskRowForAccess>(
    `SELECT t.id, t.status, t.requester_id, t.assignee_id, t.department_id,
            t.requester_department_id
       FROM tk_items t
      WHERE t.id = $${vis.params.length + 1} AND ${vis.sql}`,
    [...vis.params, itemId],
  );
  /* 404 rather than 403 when it is invisible: somebody who may not see a
     ticket should not learn that it exists. */
  if (!item) throw new NotFoundException('Ticket not found');

  const roleRows = await query<{ role: ParticipantRole }>(
    `SELECT role FROM tk_participants WHERE item_id = $1 AND user_id = $2`,
    [itemId, p.id],
  );
  return { item, access: accessFor(p, item, roleRows.map((r) => r.role)) };
}

/** Assert a capability, with a message that says what was actually wrong. */
export function assertCan(access: TaskAccess, capability: keyof TaskAccess, what: string): void {
  if (!access[capability]) throw new ForbiddenException(what);
}