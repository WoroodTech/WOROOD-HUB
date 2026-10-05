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
export const BOARD_COLUMNS = [
  'IN_PROGRESS', 'BLOCKED', 'FOR_REVIEW', 'IMPLEMENTATION', 'DONE',
] as const;

export type BoardColumn = typeof BOARD_COLUMNS[number] | 'DELAYED';

/* The card is deliberately fat. A manager scanning a board should not have to
   open a ticket to know whether it needs them, and every field here answers a
   question somebody asks before clicking: whose is it, who is doing it, when is
   it promised, how late, and did it come from outside. */
const CARD_COLUMNS = `
  t.id, t.reference, t.title, t.status, t.priority, t.sla_state,
  t.due_at, t.planned_for, t.created_at, t.overdue_since,
  t.fast_track, t.review_rejection_count, t.held_assignee_id,
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
  /** Who had it before it went on hold -- the default when it resumes. */
  heldAssigneeId: string | null;
  waitingOn: number;
  /** False on the requesting department's view: they may look, not steer. */
  draggable: boolean;
}

const toCard = (r: any, draggable: boolean): BoardCard => ({
  id: r.id, reference: r.reference, title: r.title,
  status: r.status, priority: r.priority, slaState: r.sla_state,
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
  heldAssigneeId: r.held_assignee_id ?? null,
  waitingOn: r.waiting_on ?? 0,
  draggable,
});

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
  async managerBoard(p: Principal, side: 'doing' | 'requested', departmentId?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];

    /* A manager of nothing has no board. Said plainly rather than returning
       empty columns, which reads like "no work" rather than "not for you". */
    if (!manageAny && managed.length === 0) {
      return { side, departments: [], columns: [], empty: 'notAManager' as const };
    }

    const scope = departmentId ? [departmentId] : managed;
    const column = side === 'doing' ? 't.department_id' : 't.requester_department_id';

    const rows = await query<any>(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
        WHERE ($1::boolean OR ${column} = ANY($2::uuid[]))
          AND ($3::uuid IS NULL OR ${column} = $3::uuid)
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
      [manageAny && !departmentId, scope, departmentId ?? null]);

    const draggable = side === 'doing';
    const cards = rows.map((r) => toCard(r, draggable));

    /* Delayed is drawn from sla_state, not from status, so a ticket appears
       there *and* keeps its real status on the card. A manager who sees only
       "delayed" asks the assignee why they have stopped; the answer is often
       that they have not -- they are waiting on another department. */
    const columns = [
      {
        key: 'DELAYED' as BoardColumn,
        cards: cards.filter((c) => c.slaState === 'OVERDUE'),
        /* Nothing is dragged into or out of Delayed: lateness is a fact about
           the clock, not a decision anybody makes. */
        droppable: false,
      },
      ...BOARD_COLUMNS.map((key) => ({
        key: key as BoardColumn,
        cards: cards.filter((c) => c.status === key
          || (key === 'IN_PROGRESS' && c.status === 'ASSIGNED')),
        droppable: draggable,
      })),
    ];

    const departments = await query<{ id: string; name: string }>(
      `SELECT id, name FROM core_departments
        WHERE ($1::boolean OR id = ANY($2::uuid[])) ORDER BY name`,
      [manageAny, managed]);

    return { side, departments, columns, empty: null };
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
  async decisions(p: Principal, departmentId?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];
    if (!manageAny && managed.length === 0) {
      return { groups: [], departments: [], empty: 'notAManager' as const };
    }

    const scope = departmentId ? [departmentId] : managed;
    const rows = await query<any>(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS}
        WHERE ($1::boolean OR t.department_id = ANY($2::uuid[]))
          AND ($3::uuid IS NULL OR t.department_id = $3::uuid)
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
      [manageAny && !departmentId, scope, departmentId ?? null]);

    const cards = rows.map((r) => toCard(r, false));
    const departments = await query<{ id: string; name: string }>(
      `SELECT id, name FROM core_departments
        WHERE ($1::boolean OR id = ANY($2::uuid[])) ORDER BY name`,
      [manageAny, managed]);

    return {
      empty: null, departments,
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
        WHERE t.assignee_id = $1
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

    /* Cards drag here too. It is their work, and saying where it has got to
       should not require opening the ticket.
    
       What they cannot do is park it: planning and on hold are the manager's
       decisions, and letting somebody put their own ticket on hold is letting
       them stop their own clock. Those columns are not on this board at all,
       so the question does not arise. */
    const cards = rows.map((r) => toCard(r, true));

    const columns = [
      /* Never droppable. Lateness is a fact about the clock, not a move. */
      { key: 'DELAYED' as BoardColumn, cards: cards.filter((c) => c.slaState === 'OVERDUE'), droppable: false },
      ...(['IN_PROGRESS', 'BLOCKED', 'FOR_REVIEW', 'IMPLEMENTATION', 'DONE'] as const)
        .map((key) => ({
          key: key as BoardColumn,
          cards: cards.filter((c) => c.status === key
            || (key === 'IN_PROGRESS' && c.status === 'ASSIGNED')),
          /* Only the two they can actually reach by moving a card. Blocked
             happens when a dependency is raised, implementation when the
             requester approves, and done is declared on the ticket -- offering
             those as drop targets would be offering a gesture that is refused.
             FOR_REVIEW asks for an account of the work, which the board
             collects the same way it collects a date. */
          droppable: key === 'IN_PROGRESS' || key === 'FOR_REVIEW',
        })),
    ];

    /* What is waiting on this person specifically, which is not the same as
       what is assigned to them: a ticket they raised and that is now sitting in
       review is waiting on them too, and it is not on this board at all. */
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
  async managerDashboard(p: Principal, side: 'doing' | 'requested', departmentId?: string) {
    const manageAny = can(p, TASK_PERMISSIONS.MANAGE_ANY)
      || can(p, TASK_PERMISSIONS.VIEW_ANY);
    const managed = p.managedDepartmentIds ?? [];
    if (!manageAny && managed.length === 0) {
      return { side, totals: null, people: [], empty: 'notAManager' as const };
    }

    const scope = departmentId ? [departmentId] : managed;
    const column = side === 'doing' ? 't.department_id' : 't.requester_department_id';
    const params = [manageAny && !departmentId, scope, departmentId ?? null];
    const where = `($1::boolean OR ${column} = ANY($2::uuid[]))
                   AND ($3::uuid IS NULL OR ${column} = $3::uuid)`;

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
                        AND ($1::boolean OR t.department_id = ANY($2::uuid[]))
                        AND ($3::uuid IS NULL OR t.department_id = $3::uuid)
        WHERE u.deleted_at IS NULL AND u.status = 'ACTIVE'
          AND ($1::boolean OR u.department_id = ANY($2::uuid[]))
          AND ($3::uuid IS NULL OR u.department_id = $3::uuid)
        GROUP BY u.id, u.full_name
        ORDER BY active DESC, u.full_name`, params) : [];

    const departments = await query<{ id: string; name: string }>(
      `SELECT id, name FROM core_departments
        WHERE ($1::boolean OR id = ANY($2::uuid[])) ORDER BY name`,
      [manageAny, managed]);

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