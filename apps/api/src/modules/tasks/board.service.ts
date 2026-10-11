/**
 * The three screens: the manager's board, the manager's figures, and the
 * employee's board.
 *
 * Kept apart from `tasks.service.ts`, which is about changing one ticket. These
 * read many and change none, and the queries are shaped by what a column or a
 * tile needs rather than by what a ticket is.
 *
 * **The distinction the whole module turns on:** a department can *ask* for
 * work and a department can *do* work, and those are different relationships to
 * the same ticket. Marketing asking Design for a banner appears on both
 * managers' screens and means something different on each. Getting this wrong
 * gives one manager buttons over another's pipeline.
 */
import { Injectable } from '@nestjs/common';
import { Principal, can } from '../../common/auth';
import { one, query } from '../../common/db';
import { TASK_PERMISSIONS } from './permissions';

/** Board columns, left to right, as a manager reads them. */
/* No ASSIGNED column. Assigning now starts the work, so nothing new rests
   there -- it would be an empty column on every board, taking the width of a
   real one and teaching people to scroll past it. Rows that still hold the
   status from before are shown under In progress, which is where they are in
   substance. */
/* Work in flight, and nothing else.
 *
 * Planning and On hold left this board when the Backlog screen took them. They
 * are states where nobody is holding the ticket, and mixing "not started" into
 * a board about progress meant two columns that never moved sitting in front of
 * the ones that do. The backlog is where parked work is decided; this is where
 * live work is watched. */
/* The lifecycle in order, then the two that are not stages.
 *
 * BLOCKED and DELAYED sit after DONE because neither is a step the work passes
 * through -- one is waiting on somebody else, the other is a fact about the
 * clock. Among the stages they would break the reading left to right; after
 * DONE they are two trays of exceptions, which is what they are. */
export const BOARD_COLUMNS = [
  'IN_PROGRESS', 'FOR_REVIEW', 'CHANGES_REQUESTED', 'APPROVED',
  'IMPLEMENTATION', 'DONE', 'BLOCKED',
] as const;

export type BoardColumn = typeof BOARD_COLUMNS[number] | 'DELAYED';

/* The card is deliberately fat. A manager scanning a board should not have to
   open a ticket to know whether it needs them, and every field here answers a
   question somebody asks before clicking: whose is it, who is doing it, when is
   it promised, how late, and did it come from outside. */
const CARD_COLUMNS = `
  t.id, t.reference, t.title, t.status, t.priority, t.sla_state, t.sla_reason,
  t.due_at, t.planned_for, t.created_at, t.overdue_since,
  t.fast_track, t.review_rejection_count,
  t.department_id, t.requester_department_id,
  rq.full_name  AS requester_name,
  asg.full_name AS assignee_name,
  asg.id        AS assignee_id,
  d.name        AS department_name,
  rd.name       AS requester_department_name,
  (SELECT count(*)::int FROM tk_links l
    WHERE l.item_id = t.id AND l.link_type = 'BLOCKED_BY' AND l.released_at IS NULL) AS waiting_on
`;

const CARD_JOINS = `
       FROM tk_items t
       JOIN core_users rq       ON rq.id = t.requester_id
  LEFT JOIN core_users asg      ON asg.id = t.assignee_id
       JOIN core_departments d  ON d.id = t.department_id
  LEFT JOIN core_departments rd ON rd.id = t.requester_department_id
`;

export interface BoardCard {
  id: string; reference: string; title: string;
  status: string; priority: string; slaState: string;
  slaReason: 'WORK' | 'REVIEW' | null;
  dueAt: string | null; plannedFor: string | null; createdAt: string;
  overdueSince: string | null;
  fastTrack: boolean; reviewRejectionCount: number;
  requesterName: string; assigneeName: string | null; assigneeId: string | null;
  departmentName: string; requesterDepartmentName: string | null;
  /** Needed by the assign dialog on the board: who may be picked depends on
   *  which department is doing the work. */
  departmentId: string;
  /** Raised inside the department that is doing it, rather than asked for by
   *  another. The two are read differently -- an external ticket is a promise
   *  to somebody outside, and worth seeing at a glance on a card. */
  internal: boolean;
  waitingOn: number;
  /** False on the requesting department's view: they may look, not steer. */
  draggable: boolean;
}

const toCard = (r: any, draggable: boolean): BoardCard => ({
  id: r.id, reference: r.reference, title: r.title,
  status: r.status, priority: r.priority, slaState: r.sla_state,
  slaReason: r.sla_reason ?? null,
  dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
  plannedFor: r.planned_for ? new Date(r.planned_for).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
  overdueSince: r.overdue_since ? new Date(r.overdue_since).toISOString() : null,
  fastTrack: r.fast_track === true,
  reviewRejectionCount: r.review_rejection_count ?? 0,
  requesterName: r.requester_name,
  assigneeName: r.assignee_name ?? null,
  assigneeId: r.assignee_id ?? null,
  departmentName: r.department_name,
  requesterDepartmentName: r.requester_department_name ?? null,
  departmentId: r.department_id,
  /* Null requester department means a person with no department raised it;
     treated as external, because it certainly did not come from inside the
     team doing the work. */
  internal: !!r.requester_department_id && r.requester_department_id === r.department_id,
  waitingOn: r.waiting_on ?? 0,
  draggable,
});


/**
 * What "filter by department" means, which depends on who is asking.
 *
 * The control looks the same in both roles and asks a different question, and
 * that is deliberate rather than sloppy: each role has one question it actually
 * has about another department, and it is not the same question.
 *
 * **An administrator** oversees the whole organisation, so picking Marketing
 * means "everything Marketing asked for" -- what they asked of other
 * departments and what they raised for themselves, together. The useful axis is
 * the department that *wanted* the work, because who ended up doing it is the
 * answer rather than the question. The card then names the department doing it.
 *
 * **A manager** runs one department, so picking Marketing means "what Marketing
 * asked of us". Their own department is always one side of it; the filter
 * chooses the other. Showing them everything Marketing asked of everybody would
 * be showing them other people's queues.
 *
 * Returns SQL fragments rather than a boolean, so the two readings live here
 * instead of being rebuilt, slightly differently, in each query.
 */
export function departmentScope(
  manageAny: boolean, managed: string[], userId: string,
  standingIn?: string, askedBy?: string,
): { sql: string; params: unknown[] } {
  const ps: unknown[] = [];
  const bind = (v: unknown) => { ps.push(v); return `$${ps.length}`; };

  /* Which department am I looking from.
   *
   * An administrator picks one and sees what its manager sees. Picking nobody
   * shows the whole company, which is the only view nobody else has and the
   * reason the role exists. */
  let base: string;
  if (manageAny) {
    base = standingIn
      ? `(t.department_id = ${bind(standingIn)}::uuid
          OR t.requester_department_id = $${ps.length}::uuid)`
      : 'TRUE';
  } else {
    /* A manager sees their department's work, and the work their department
       asked of others.
    
       The second half is the change: a ticket Marketing raised against Design
       belongs on Marketing's board too. They cannot move it -- the card says so
       -- but not showing it at all meant the only way to find out how your own
       request was going was to ask somebody. */
    const mine = bind(managed);
    base = `(t.department_id = ANY(${mine}::uuid[])
             OR t.requester_department_id = ANY(${mine}::uuid[])
             OR t.requester_id = ${bind(userId)}::uuid)`;
  }

  /* And then: narrowed to what one other department asked of it. Applies to
     both roles, because "who asked us for this" is the same question whether
     you manage the department or are standing in it. */
  if (askedBy) base += ` AND t.requester_department_id = ${bind(askedBy)}::uuid`;

  return { sql: base, params: ps };
}

/**
 * The departments worth offering in the filter.
 *
 * An administrator gets all of them. A manager gets the ones that have actually
 * asked their department for something -- a list of every department in the
 * company would mostly be options that return nothing, and an option that
 * returns nothing teaches people the filter is broken.
 */
async function filterDepartments(manageAny: boolean, managed: string[]) {
  if (manageAny) {
    return query<{ id: string; name: string }>(
      `SELECT id, name FROM core_departments ORDER BY name`);
  }
  return query<{ id: string; name: string }>(
    `SELECT id, name FROM core_departments WHERE id = ANY($1::uuid[]) ORDER BY name`,
    [managed]);
}

/**
 * The departments that have actually asked this one for something.
 *
 * Offered as the second filter, and built from the tickets rather than from the
 * org chart: a list of every department in the company would mostly be options
 * that return nothing, and an option that returns nothing teaches people the
 * filter is broken.
 */
async function requestingDepartments(
  manageAny: boolean, managed: string[], standingIn?: string,
) {
  const target = standingIn ? [standingIn] : managed;
  if (manageAny && !standingIn) {
    return query<{ id: string; name: string }>(
      `SELECT DISTINCT d.id, d.name
         FROM tk_items t JOIN core_departments d ON d.id = t.requester_department_id
        WHERE t.requester_department_id IS NOT NULL ORDER BY d.name`);
  }
  return query<{ id: string; name: string }>(
    `SELECT DISTINCT d.id, d.name
       FROM tk_items t JOIN core_departments d ON d.id = t.requester_department_id
      WHERE t.department_id = ANY($1::uuid[])
        AND t.requester_department_id IS NOT NULL
      ORDER BY d.name`, [target]);
}

@Injectable()
export class BoardService {

  /**
   * The manager's board.
   *
   * `side` is the question being asked, not a filter over one answer:
   *
   *   doing     — work my department is carrying out. Cards drag; this is my
   *               pipeline and these states are mine to move.
   *   requested — work my department asked another department for. Cards do not
   *               drag. I may watch it, chase it and cancel it, but moving
   *               somebody else's ticket through their pipeline is not
   *               oversight, it is interference — and the API would refuse it
   *               anyway, so offering the gesture would only teach the board
   *               cannot be trusted.
   */
  async managerBoard(p: Principal, side: 'doing' | 'requested',
                     departmentId?: string, askedBy?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];

    /* A manager of nothing has no board. Said plainly rather than returning
       empty columns, which reads like "no work" rather than "not for you". */
    if (!manageAny && managed.length === 0) {
      return { side, departments: [], requesters: [], standingIn: null,
               columns: [], empty: 'notAManager' as const };
    }

    const scope = departmentScope(manageAny, managed, p.id, departmentId, askedBy);

    const rows = await query<any>(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
        WHERE ${scope.sql}
          /* Cancelled and refused tickets are not on a board. They are
             answers, not work, and a column of them would grow for ever
             without anybody ever acting on one. */
          AND t.status NOT IN ('CANCELLED','REJECTED','NEW','PLANNING','ON_HOLD')
          /* Done is kept for a fortnight. Long enough to see what shipped this
             week, short enough that the column does not become an archive
             nobody scrolls. */
          AND (t.status <> 'DONE' OR t.done_at > now() - interval '14 days')
        ORDER BY
          CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                          WHEN 'NORMAL' THEN 2 ELSE 3 END,
          COALESCE(t.due_at, t.planned_for, t.created_at)`,
      scope.params);

    /* Draggable only where the viewer's department is the one doing the work.
    
       The board now also carries tickets this department *asked for*, which
       another department is carrying out. Those are visible and not movable --
       and the card is marked individually rather than the whole board, because
       after this change one board holds both kinds. */
    const doingHere = (r: any) => manageAny
      ? (!departmentId || r.department_id === departmentId)
      : managed.includes(r.department_id);
    const cards = rows.map((r) => toCard(r, side === 'doing' && doingHere(r)));
    const draggable = side === 'doing';

    /* Delayed is drawn from sla_state, not from status, so a ticket appears
       there *and* keeps its real status on the card. A manager who sees only
       "delayed" asks the assignee why they have stopped; the answer is often
       that they have not -- they are waiting on another department. */
    const columns = [
      ...BOARD_COLUMNS.map((key) => ({
        key: key as BoardColumn,
        cards: cards.filter((c) => c.status === key
          || (key === 'IN_PROGRESS' && c.status === 'ASSIGNED')),
        droppable: draggable,
      })),
      {
        key: 'DELAYED' as BoardColumn,
        cards: cards.filter((c) => c.slaState === 'OVERDUE'),
        /* Nothing is dragged into or out of Delayed: lateness is a fact about
           the clock, not a decision anybody makes. */
        droppable: false,
      },
    ];

    const [departments, requesters] = await Promise.all([
      filterDepartments(manageAny, managed),
      requestingDepartments(manageAny, managed, departmentId),
    ]);

    return { side, departments, requesters, standingIn: departmentId ?? null, columns, empty: null };
  }

  /**
   * The manager's daily queue: everything with nobody on it.
   *
   * Three groups, and they are the same question asked three ways — what has
   * nobody holding it, and what did I decide about each. A new ticket is
   * undecided; a planned one has a date; a held one has a reason. All three
   * leave the moment somebody is assigned, which is what makes this a queue
   * rather than a list: it empties as it is worked.
   *
   * Separate from the board on purpose. The board is about work in flight; this
   * is about work that has not started, and a manager opens it once a morning
   * to clear it.
   */
  async decisions(p: Principal, departmentId?: string, askedBy?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];
    if (!manageAny && managed.length === 0) {
      return { groups: [], departments: [], requesters: [], standingIn: null,
               empty: 'notAManager' as const };
    }

    const scope = departmentScope(manageAny, managed, p.id, departmentId, askedBy);
    const rows = await query<any>(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
        WHERE ${scope.sql}
          AND t.status IN ('NEW','PLANNING','ON_HOLD','CANCELLED')
          /* Cancelled work is kept for a month. Long enough that somebody who
             changes their mind can find it, short enough that the section does
             not become a graveyard nobody reads past. */
          AND (t.status <> 'CANCELLED' OR t.status_changed_at > now() - interval '30 days')
        ORDER BY
          CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                          WHEN 'NORMAL' THEN 2 ELSE 3 END,
          /* Planned tickets by their date -- the soonest is the one to act on.
             The rest by age, oldest first, because a new ticket nobody has
             looked at for three days is the one that needs looking at. */
          COALESCE(t.planned_for, t.created_at)`,
      scope.params);

    const cards = rows.map((r) => toCard(r, false));
    const [departments, requesters] = await Promise.all([
      filterDepartments(manageAny, managed),
      requestingDepartments(manageAny, managed, departmentId),
    ]);

    return {
      empty: null, departments, requesters, standingIn: departmentId ?? null,
      groups: [
        { key: 'NEW', cards: cards.filter((c) => c.status === 'NEW') },
        { key: 'PLANNING', cards: cards.filter((c) => c.status === 'PLANNING') },
        { key: 'ON_HOLD', cards: cards.filter((c) => c.status === 'ON_HOLD') },
        { key: 'CANCELLED', cards: cards.filter((c) => c.status === 'CANCELLED') },
      ],
    };
  }

  /**
   * The employee's board: only what is on them.
   *
   * Not the manager's board filtered by assignee. The columns differ, because
   * the questions differ -- an employee needs to know what is waiting for them
   * to act, and PLANNING and ON_HOLD are states where nobody is holding the
   * ticket at all.
   */
  async myBoard(p: Principal) {
    const rows = await query<any>(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
        /* Mine to do, or mine because I asked for it.
        
           A ticket you raised is yours to watch -- and once it reaches review
           it is yours to act on, because approving is the requester's. Leaving
           it off this board meant the one screen a person checks never showed
           the thing that was waiting for them. */
        WHERE (t.assignee_id = $1 OR t.requester_id = $1)
          AND t.status NOT IN ('CANCELLED','REJECTED')
          /* Everything finished stays. An employee's own record of what they
             have done is worth more than a tidy column, and the volume is one
             person's work rather than a department's. */
        ORDER BY
          CASE t.sla_state WHEN 'OVERDUE' THEN 0 WHEN 'DUE_SOON' THEN 1 ELSE 2 END,
          CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                          WHEN 'NORMAL' THEN 2 ELSE 3 END,
          COALESCE(t.due_at, t.created_at)`,
      [p.id]);

    /* Drag is per card, not per board. This board now carries work somebody
       else is doing on your behalf, and moving another person's ticket through
       their states is not yours -- so only the ones assigned to you move.
    
       What they cannot do is park it: planning and on hold are the manager's
       decisions, and letting somebody put their own ticket on hold is letting
       them stop their own clock. Those columns are not on this board at all,
       so the question does not arise. */
    const cards = rows.map((r) => toCard(r, r.assignee_id === p.id));

    const columns = [
      ...(['IN_PROGRESS', 'FOR_REVIEW', 'CHANGES_REQUESTED', 'APPROVED',
           'IMPLEMENTATION', 'DONE', 'BLOCKED'] as const)
        .map((key) => ({
          key: key as BoardColumn,
          cards: cards.filter((c) => c.status === key
            || (key === 'IN_PROGRESS' && c.status === 'ASSIGNED')),
          /* Only the two they can actually reach by moving a card. Blocked
             happens when a dependency is raised, implementation when the
             done is declared on the ticket -- offering those as drop targets
             would be offering a gesture that is refused. FOR_REVIEW asks for an
             account of the work and IMPLEMENTATION needs nothing, which is why
             both are here and APPROVED is not: approving is the requester's. */
          /* Done is reachable by dragging: "it is in place" is the assignee's
             own statement and needs nothing else from them. APPROVED is not --
             that is the requester's judgement, taken on the ticket. */
          droppable: key === 'IN_PROGRESS' || key === 'FOR_REVIEW'
            || key === 'IMPLEMENTATION' || key === 'DONE',
        })),
      /* Never droppable. Lateness is a fact about the clock, not a move. */
      { key: 'DELAYED' as BoardColumn, cards: cards.filter((c) => c.slaState === 'OVERDUE'), droppable: false },
    ];

    /* How many of the cards above are waiting on *this* person to review.
       They are on the board now, in the For review column -- this is the count
       that tells them to look there. */
    const awaitingMyReview = await one<{ n: string }>(
      `SELECT count(*)::int AS n FROM tk_items
        WHERE requester_id = $1 AND status = 'FOR_REVIEW'`, [p.id]);

    return { columns, awaitingMyReview: Number(awaitingMyReview?.n ?? 0) };
  }

  /**
   * The manager's figures.
   *
   * Counts by state, and the same counts per person. Deliberately counts and
   * nothing else -- no averages, no scores, no ratios. This is the data a KPI
   * would be built from, and building the measure before anybody has agreed
   * what good looks like is how a team ends up managed by a number nobody
   * chose.
   */
  async managerDashboard(p: Principal, side: 'doing' | 'requested',
                         departmentId?: string, askedBy?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];
    if (!manageAny && managed.length === 0) {
      return { side, totals: null, people: [], empty: 'notAManager' as const };
    }

    const scope = departmentScope(manageAny, managed, p.id, departmentId, askedBy);
    const params = scope.params;
    const where = scope.sql;

    const totals = await one<any>(
      `SELECT
         count(*)::int                                                   AS total,
         count(*) FILTER (WHERE t.status = 'NEW')::int                   AS unassigned,
         count(*) FILTER (WHERE t.status = 'PLANNING')::int              AS planning,
         count(*) FILTER (WHERE t.status = 'ON_HOLD')::int               AS on_hold,
         count(*) FILTER (WHERE t.status = 'ASSIGNED')::int              AS assigned,
         count(*) FILTER (WHERE t.status = 'IN_PROGRESS')::int           AS in_progress,
         count(*) FILTER (WHERE t.status = 'BLOCKED')::int               AS blocked,
         count(*) FILTER (WHERE t.status = 'FOR_REVIEW')::int            AS for_review,
         count(*) FILTER (WHERE t.status = 'IMPLEMENTATION')::int        AS implementation,
         count(*) FILTER (WHERE t.status = 'DONE')::int                  AS done,
         count(*) FILTER (WHERE t.status = 'CANCELLED')::int             AS cancelled,
         /* Late is counted across every live state, for the same reason the
            board draws it from sla_state: a blocked ticket that has gone late
            is both, and reporting only one of the two loses the half that
            explains the other. */
         count(*) FILTER (WHERE t.sla_state = 'OVERDUE'
                            AND t.status NOT IN ('DONE','CANCELLED','REJECTED'))::int AS delayed,
         count(*) FILTER (WHERE t.fast_track)::int                       AS fast_tracked,
         count(*) FILTER (WHERE t.review_rejection_count > 0)::int       AS sent_back_at_least_once
       ${CARD_JOINS} WHERE ${where}`, params);

    /* Everybody in the department, not everybody with a ticket. A person with
       none is the most interesting row on the page and a query grouped by
       assignee would leave them out. */
    const people = side === 'doing' ? await query<any>(
      `SELECT u.id, u.full_name,
              count(t.id) FILTER (WHERE t.status NOT IN ('DONE','CANCELLED','REJECTED'))::int AS active,
              count(t.id) FILTER (WHERE t.status = 'IN_PROGRESS')::int     AS in_progress,
              count(t.id) FILTER (WHERE t.status = 'BLOCKED')::int         AS blocked,
              count(t.id) FILTER (WHERE t.status = 'FOR_REVIEW')::int      AS for_review,
              count(t.id) FILTER (WHERE t.status = 'IMPLEMENTATION')::int  AS implementation,
              count(t.id) FILTER (WHERE t.status = 'DONE')::int            AS done,
              count(t.id) FILTER (WHERE t.sla_state = 'OVERDUE'
                                   AND t.status NOT IN ('DONE','CANCELLED','REJECTED'))::int AS delayed
         FROM core_users u
    LEFT JOIN tk_items t ON t.assignee_id = u.id
        /* People are listed by the department they belong to, not by the
           filter: the filter asks whose *requests* to look at, and a person
           does not belong to the department that asked them for something. */
        WHERE u.deleted_at IS NULL AND u.status = 'ACTIVE'
          AND ($1::boolean OR u.department_id = ANY($2::uuid[]))
        GROUP BY u.id, u.full_name
        ORDER BY active DESC, u.full_name`, [manageAny, managed]) : [];

    const departments = await filterDepartments(manageAny, managed);

    return {
      side, departments, empty: null,
      totals: {
        total: totals?.total ?? 0,
        unassigned: totals?.unassigned ?? 0,
        planning: totals?.planning ?? 0,
        onHold: totals?.on_hold ?? 0,
        assigned: totals?.assigned ?? 0,
        inProgress: totals?.in_progress ?? 0,
        blocked: totals?.blocked ?? 0,
        forReview: totals?.for_review ?? 0,
        implementation: totals?.implementation ?? 0,
        done: totals?.done ?? 0,
        cancelled: totals?.cancelled ?? 0,
        delayed: totals?.delayed ?? 0,
        fastTracked: totals?.fast_tracked ?? 0,
        sentBackAtLeastOnce: totals?.sent_back_at_least_once ?? 0,
      },
      people: people.map((r) => ({
        id: r.id, name: r.full_name,
        active: r.active, inProgress: r.in_progress, blocked: r.blocked,
        forReview: r.for_review, implementation: r.implementation,
        done: r.done, delayed: r.delayed,
      })),
    };
  }
}