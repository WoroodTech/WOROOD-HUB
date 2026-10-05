/**
 * Module 3: the ticket workflow.
 *
 * Three rules hold everywhere in this file and are worth stating once rather
 * than repeating in every method.
 *
 * 1. Every state change writes an event. `tk_events` is what the employee
 *    reads as the timeline, what the notification fan-out walks, and what the
 *    reporting counts. A change that skips it is a change nobody can explain
 *    afterwards.
 *
 * 2. The participant list is the notification list. They are the same rows, so
 *    they cannot drift apart -- the commonest way a system starts telling the
 *    wrong people about the right things.
 *
 * 3. A notification failure never fails the operation. The assignment is the
 *    row in tk_participants; the notification is the announcement. Losing a
 *    ticket because an insert into core_notifications failed would be far
 *    worse than somebody finding it on their home screen unprompted. This is
 *    the same principle Module 1 settled on for meeting invitations.
 */
import {
  ForbiddenException,
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Principal, can } from '../../common/auth';
import { one, query, tx } from '../../common/db';
import { AuditService, NotificationsService } from '../../core/core.module';
import { TASK_PERMISSIONS } from './permissions';
import {
  AddComment, AddDependency, AssignTask, CreateTask, ListTasksQuery,
  ManageContributor, MoveTask, PlanTask, ReasonOnly, ResolveTask, SetDue,
  TransferTask, UpdateRequest,
} from './dto';
import {
  ParticipantRole, TaskAccess, accessFor, assertCan, canMove, loadWithAccess,
  nextAfterWork, visibilityFilter, type TaskStatus,
} from './visibility.service';
import { NotificationMailer } from '../../core/notifications.controller';
import { config } from '../../common/config';
import { ticketMail } from './ticket-mail';
import { writeEvent } from './events';
import { AttachmentsService } from './attachments.service';

const MODULE_KEY = 'tasks';

/** The status as a person says it. Used in refusals, which are read by whoever
 *  just tried something — so they must name the states the screen names. */
const READABLE: Record<string, string> = {
  NEW: 'New', PLANNING: 'Planning', ON_HOLD: 'On hold', ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', FOR_REVIEW: 'For review',
  IMPLEMENTATION: 'Implementation', DONE: 'Done', REJECTED: 'Refused',
  CANCELLED: 'Cancelled',
};
const readableStatus = (s: string) => READABLE[s] ?? s;
const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED'];
const CLOSED_STATUSES = ['CLOSED', 'REJECTED', 'CANCELLED'];

/** Columns every list and detail response is built from. */
const ITEM_COLUMNS = `
  t.id, t.reference, t.title, t.description, t.priority, t.status, t.status_reason,
  t.status_changed_at, t.requester_id, t.department_id, t.assignee_id,
  t.due_at, t.sla_state, t.overdue_since, t.assigned_at, t.resolved_at,
  t.closed_at, t.reopened_count, t.created_at, t.updated_at,
  t.fast_track, t.planned_for, t.review_rejected_reason, t.review_rejection_count,
  t.blocked_at, t.implementation_started_at, t.done_at, t.held_assignee_id,
  d.name AS department_name, d.name_ar AS department_name_ar,
  t.requester_department_id, rd.name AS requester_department_name,
  ru.full_name AS requester_name, ru.job_title AS requester_title,
  au.full_name AS assignee_name, au.job_title AS assignee_title,
  (SELECT count(*)::int FROM tk_comments c WHERE c.item_id = t.id AND c.deleted_at IS NULL) AS comment_count,
  (SELECT count(*)::int FROM tk_links l
    WHERE l.item_id = t.id AND l.link_type = 'BLOCKED_BY' AND l.released_at IS NULL) AS open_blocker_count`;

const ITEM_JOINS = `
  FROM tk_items t
  JOIN core_departments d ON d.id = t.department_id
  LEFT JOIN core_departments rd ON rd.id = t.requester_department_id
  JOIN core_users ru      ON ru.id = t.requester_id
  LEFT JOIN core_users au ON au.id = t.assignee_id`;

@Injectable()
export class TasksService {
  private readonly log = new Logger(TasksService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly mailer: NotificationMailer,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------------------------------------- reads -- */

  async list(p: Principal, q: ListTasksQuery) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    const params: any[] = [];
    const where: string[] = [];

    /* Every scope sits INSIDE the visibility filter rather than beside it.
       "Everything in my department" still cannot show a colleague's ticket
       that I am not on -- the queue is a view of what I may see, never a way
       around it. */
    const vis = visibilityFilter(p, 't', 1);
    params.push(...vis.params);
    where.push(vis.sql);

    const scope = q.scope ?? 'assigned';
    const mine = () => { params.push(p.id); return `$${params.length}::uuid`; };
    const managed = () => { params.push(p.managedDepartmentIds ?? []); return `$${params.length}::uuid[]`; };

    if (scope === 'requested') where.push(`t.requester_id = ${mine()}`);
    else if (scope === 'assigned') where.push(`t.assignee_id = ${mine()}`);
    else if (scope === 'contributing') {
      const u = mine();
      where.push(`EXISTS (SELECT 1 FROM tk_participants pc
                           WHERE pc.item_id = t.id AND pc.user_id = ${u}
                             AND pc.role IN ('CONTRIBUTOR','PAST_ASSIGNEE','OBSERVER'))`);
    } else if (scope === 'queue') {
      where.push(`t.status = 'NEW' AND t.department_id = ANY(${managed()})`);
    } else if (scope === 'department') {
      /* Both directions: what was asked of my department, and what my people
         asked of others. A manager who can only see incoming work has half a
         picture of what their team is doing. */
      const m = managed();
      where.push(`(t.department_id = ANY(${m}) OR t.requester_department_id = ANY(${m}))`);
    } else if (scope === 'all') {
      if (!can(p, TASK_PERMISSIONS.VIEW_ANY) && !can(p, TASK_PERMISSIONS.MANAGE_ANY)) {
        throw new NotFoundException('Not available to your account');
      }
    }

    if (q.departmentId) { params.push(q.departmentId); where.push(`t.department_id = $${params.length}`); }
    if (q.priority) { params.push(q.priority); where.push(`t.priority = $${params.length}`); }
    if (q.overdue === 'true') where.push(`t.sla_state = 'OVERDUE'`);

    const statuses = parseStatuses(q.status);
    if (statuses) { params.push(statuses); where.push(`t.status = ANY($${params.length}::text[])`); }

    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(t.title ILIKE $${params.length} OR t.reference ILIKE $${params.length})`);
    }

    const sql = `${where.join(' AND ')}`;
    const total = await one<{ n: number }>(
      `SELECT count(*)::int AS n ${ITEM_JOINS} WHERE ${sql}`, params);

    /* Finished work sinks. The default list shows everything, because a ticket
       closed an hour ago is exactly the one somebody comes looking for -- but
       it must not push live work down the page to do it. */
    params.push(OPEN_STATUSES);
    const liveFirst = `(t.status = ANY($${params.length}::text[]))`;

    params.push(pageSize, (page - 1) * pageSize);
    const rows = await query(
      `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE ${sql}
        ORDER BY ${liveFirst} DESC,
                 (t.sla_state = 'OVERDUE' AND ${liveFirst}) DESC,
                 CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1
                                 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                 t.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    return {
      items: rows.map(shapeItem),
      page, pageSize, total: total?.n ?? 0,
      counts: await this.counts(p),
    };
  }

  /** The tab badges, in one round trip rather than five list calls. */
  async counts(p: Principal) {
    const vis = visibilityFilter(p, 't', 1);
    const params = [...vis.params, p.id, p.managedDepartmentIds ?? []];
    const r = await one<any>(
      `SELECT
         count(*) FILTER (WHERE t.assignee_id = $4 AND t.status = ANY($6::text[]))::int      AS assigned,
         count(*) FILTER (WHERE t.requester_id = $4 AND t.status = ANY($6::text[]))::int     AS requested,
         count(*) FILTER (WHERE t.requester_id = $4 AND t.status = 'RESOLVED')::int          AS awaiting_me,
         count(*) FILTER (WHERE t.status = 'NEW' AND t.department_id = ANY($5::uuid[]))::int AS queue,
         count(*) FILTER (WHERE t.sla_state = 'OVERDUE' AND t.status = ANY($6::text[]))::int AS overdue
       ${ITEM_JOINS} WHERE ${vis.sql}`,
      [...params, OPEN_STATUSES]);
    return {
      assigned: r?.assigned ?? 0, requested: r?.requested ?? 0,
      awaitingMe: r?.awaiting_me ?? 0, queue: r?.queue ?? 0, overdue: r?.overdue ?? 0,
    };
  }

  async detail(p: Principal, id: string) {
    const { access } = await loadWithAccess(p, id);
    const row = await one<any>(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE t.id = $1`, [id]);
    if (!row) throw new NotFoundException('Ticket not found');

    const participants = await query(
      `SELECT pa.role, pa.added_at, u.id, u.full_name, u.job_title, d.name AS department
         FROM tk_participants pa
         JOIN core_users u        ON u.id = pa.user_id
         LEFT JOIN core_departments d ON d.id = u.department_id
        WHERE pa.item_id = $1
        ORDER BY CASE pa.role WHEN 'REQUESTER' THEN 0 WHEN 'ASSIGNEE' THEN 1
                              WHEN 'CONTRIBUTOR' THEN 2 ELSE 3 END, u.full_name`, [id]);

    const comments = await query(
      `SELECT c.id, c.body, c.created_at, c.edited_at, u.id AS author_id,
              u.full_name AS author_name, u.job_title AS author_title
         FROM tk_comments c JOIN core_users u ON u.id = c.author_id
        WHERE c.item_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at`, [id]);

    const events = await query(
      `SELECT e.id, e.type, e.payload, e.created_at,
              u.full_name AS actor_name
         FROM tk_events e LEFT JOIN core_users u ON u.id = e.actor_id
        WHERE e.item_id = $1 ORDER BY e.created_at`, [id]);

    /* Signed after the visibility check above, so who may see a file is the
       rule about who may see the ticket -- written once, not twice. */
    const files = await this.attachments.forItem(p, id);

    return {
      ...shapeItem(row),
      access: publicAccess(access),
      attachments: files.filter((f) => !f.commentId),
      participants: participants.map((r) => ({
        userId: r.id, name: r.full_name, jobTitle: r.job_title,
        department: r.department, role: r.role as ParticipantRole, addedAt: r.added_at,
      })),
      comments: comments.map((c) => ({
        id: c.id, body: c.body, createdAt: c.created_at, editedAt: c.edited_at,
        authorId: c.author_id, authorName: c.author_name, authorTitle: c.author_title,
        attachments: files.filter((f) => f.commentId === c.id),
      })),
      events: events.map((e) => ({
        id: e.id, type: e.type, payload: e.payload, createdAt: e.created_at,
        actorName: e.actor_name,
      })),
      blockedBy: await this.dependencySummaries(p, id, 'blocked-by'),
      blocking: await this.dependencySummaries(p, id, 'blocking'),
    };
  }

  /**
   * What a dependency looks like from the other side of a department wall.
   *
   * The requester of a blocked ticket is entitled to know it is waiting, on
   * whom, since when, and whether anyone has picked it up. They are not
   * entitled to the other department's title, description or conversation --
   * that is work they are not part of. So the title is attached only when the
   * reader can see the blocking ticket in its own right.
   */
  private async dependencySummaries(p: Principal, id: string, direction: 'blocked-by' | 'blocking') {
    const vis = visibilityFilter(p, 't', 2);
    const rows = await query(
      `SELECT l.id AS link_id, l.created_at AS linked_at, l.released_at,
              t.id, t.reference, t.title, t.status, t.due_at, t.created_at,
              d.name AS department_name,
              ${vis.sql} AS may_see
         ${ITEM_JOINS.replace('FROM tk_items t', 'FROM tk_links l JOIN tk_items t ON t.id = ' +
            (direction === 'blocked-by' ? 'l.depends_on_item_id' : 'l.item_id'))}
        WHERE ${direction === 'blocked-by' ? 'l.item_id' : 'l.depends_on_item_id'} = $1
          AND l.link_type = 'BLOCKED_BY'
        ORDER BY l.created_at`,
      [id, ...vis.params]);

    return rows.map((r) => ({
      linkId: r.link_id, itemId: r.id, reference: r.reference,
      department: r.department_name, status: r.status,
      dueAt: r.due_at, raisedAt: r.created_at, releasedAt: r.released_at,
      /* Absent, not blanked. A field that is present and empty invites the
         reader to wonder what was removed. */
      title: r.may_see ? r.title : undefined,
      readable: !!r.may_see,
    }));
  }

  /* ------------------------------------------------------------ writes -- */

  async create(p: Principal, dto: CreateTask) {
    const departmentId = dto.departmentId ?? p.departmentId;
    if (!departmentId) {
      throw new BadRequestException(
        'You are not in a department yet, so there is nobody to address this to. Ask an administrator to set yours.');
    }
    await this.assertDepartmentIsStaffed(departmentId);

    const selfAssigned = !!dto.assignToSelf && dto.assignToSelf === p.id;
    if (dto.assignToSelf && !selfAssigned) {
      throw new BadRequestException(
        'You can only put a ticket straight onto yourself. Raise it to the department and let the manager assign it.');
    }
    if (selfAssigned && departmentId !== p.departmentId) {
      throw new BadRequestException('A ticket for yourself belongs to your own department.');
    }

    const item = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tk_items (title, description, priority, requester_id,
                               requester_department_id, department_id,
                               assignee_id, assigned_at, assigned_by, status,
                               status_changed_by, fast_track)
         VALUES ($1,$2,COALESCE($3,'NORMAL'),$4,$5,$6,$7,$8,$9,$10,$4,$11)
         RETURNING id, reference, status, fast_track`,
        [dto.title, dto.description ?? null, dto.priority ?? null, p.id,
         p.departmentId ?? null, departmentId,
         selfAssigned ? p.id : null, selfAssigned ? new Date() : null,
         /* A ticket raised for yourself is work you are already doing -- you
            wrote it down because it is on your plate. Starting it in a separate
            gesture would be admitting to yourself what you just typed. */
         selfAssigned ? p.id : null, selfAssigned ? 'IN_PROGRESS' : 'NEW',
         dto.fastTrack === true]);
      const created = rows[0];

      await addParticipant(c, created.id, p.id, 'REQUESTER', p.id);
      if (selfAssigned) await addParticipant(c, created.id, p.id, 'ASSIGNEE', p.id);
      await writeEvent(c, created.id, p.id, 'CREATED', { departmentId, selfAssigned });
      return created;
    });

    await this.audit.write({
      actorId: p.id, moduleKey: MODULE_KEY, action: 'task.create',
      entityType: 'tk_items', entityId: item.id, payload: { reference: item.reference },
    });

    if (!selfAssigned) {
      await this.tell(departmentManagersOf(departmentId), p,
        `New ticket for your department: ${item.reference}`,
        `${p.fullName} raised "${dto.title}".`, item.id);
    }
    return this.detail(p, item.id);
  }

  async updateRequest(p: Principal, id: string, dto: UpdateRequest) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canEditRequest',
      'The request can only be edited before somebody picks it up. Add a comment instead, or cancel it and raise a new one.');

    if (dto.departmentId && dto.departmentId !== item.department_id) {
      await this.assertDepartmentIsStaffed(dto.departmentId);
    }

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items SET title = COALESCE($2,title), description = COALESCE($3,description),
                             priority = COALESCE($4,priority), department_id = COALESCE($5,department_id)
          WHERE id = $1`,
        [id, dto.title ?? null, dto.description ?? null, dto.priority ?? null, dto.departmentId ?? null]);
      await writeEvent(c, id, p.id, 'REQUEST_EDITED', { fields: Object.keys(dto) });
    });
    return this.detail(p, id);
  }

  async assign(p: Principal, id: string, dto: AssignTask) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canAssign', 'Only a manager of this department may assign it.');

    const target = await one<any>(
      `SELECT id, full_name, department_id FROM core_users
        WHERE id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'`, [dto.assigneeId]);
    if (!target) throw new NotFoundException('That person is not an active employee.');
    if (target.department_id !== item.department_id) {
      throw new BadRequestException(
        `${target.full_name} is not in this department. Transfer the ticket instead if it belongs elsewhere.`);
    }
    if (item.assignee_id === target.id) {
      throw new ConflictException(`${target.full_name} already has this one.`);
    }

    /* Two managers on one department is deliberate -- it is how cover during
       leave works -- so two of them can reach for the same ticket in the same
       moment. The one who gets there second is told it has gone rather than
       left believing they assigned it. */
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (dueAt && (Number.isNaN(dueAt.getTime()) || dueAt.getTime() < Date.now() - 60_000)) {
      throw new BadRequestException('The due date has to be in the future.');
    }

    const previous = item.assignee_id;
    const moved = await tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE tk_items
            SET assignee_id = $2, assigned_at = now(), assigned_by = $3,
                /* A date given with the assignment replaces any old one; none
                   given leaves what was there. Either way the late flag starts
                   clean, because the commitment is new. */
                due_at = COALESCE($5::timestamptz, due_at),
                sla_state = CASE WHEN $5::timestamptz IS NOT NULL THEN 'ON_TIME' ELSE sla_state END,
                overdue_since = CASE WHEN $5::timestamptz IS NOT NULL THEN NULL ELSE overdue_since END,
                /* Straight to IN_PROGRESS.
                
                   ASSIGNED was a state nobody acted in: a manager gave the
                   ticket to somebody, and it then sat waiting for that person
                   to press Start -- a button whose only effect was to admit
                   they had been given it. Boards filled with a column that
                   meant "assigned but not yet acknowledged", which is a fact
                   about the button rather than about the work.
                
                   Giving somebody a ticket is the moment it starts. The status
                   remains in the schema for rows that already hold it and for
                   history. */
                status = 'IN_PROGRESS',
                /* The parking is over. A planned date that has been acted on is
                   history, and a hold reason left on an assigned ticket reads
                   as though it is still held. */
                planned_for = NULL, status_reason = NULL, held_assignee_id = NULL,
                status_changed_at = now(), status_changed_by = $3
          /* PLANNING and ON_HOLD belong here: assigning is exactly how a parked
             ticket comes back to life, and leaving them out meant the UPDATE
             matched nothing and the caller was told somebody else had assigned
             it a moment ago -- a message about a race that had not happened,
             on the most ordinary action a manager takes. */
          WHERE id = $1
            AND status IN ('NEW','PLANNING','ON_HOLD','ASSIGNED','IN_PROGRESS','BLOCKED')
            AND assignee_id IS NOT DISTINCT FROM $4`,
        [id, target.id, p.id, previous, dueAt]);
      if (rowCount === 0) return false;

      if (previous) {
        await c.query(`DELETE FROM tk_participants WHERE item_id=$1 AND user_id=$2 AND role='ASSIGNEE'`,
          [id, previous]);
        await addParticipant(c, id, previous, 'PAST_ASSIGNEE', p.id);
      }
      await addParticipant(c, id, target.id, 'ASSIGNEE', p.id);
      await writeEvent(c, id, p.id, previous ? 'REASSIGNED' : 'ASSIGNED_AND_STARTED',
        { assigneeId: target.id, assigneeName: target.full_name, previousAssigneeId: previous, note: dto.note });
      return true;
    });

    if (!moved) {
      /* Reached only when the ticket moved under us -- it was finished,
         cancelled, or given to somebody else between the read and the write. */
      throw new ConflictException(
        'This ticket changed while you were looking at it. Reload to see where it stands.');
    }

    await this.tell([target.id], p, `Assigned to you: ${await reference(id)}`,
      dto.note ?? `${p.fullName} gave you this one.`, id);
    await this.tellParticipants(id, p, `Ticket assigned: ${await reference(id)}`,
      `${p.fullName} assigned it to ${target.full_name}.`, [target.id]);
    /* The other manager of the department needs to stop looking at it. */
    await this.tell(await coManagers(item.department_id, p.id), p,
      `No longer waiting: ${await reference(id)}`,
      `${p.fullName} assigned it to ${target.full_name}.`, id);
    return this.detail(p, id);
  }

  /**
   * Park a ticket for a date, with nobody holding it yet.
   *
   * Planning deliberately does not take an assignee. Naming somebody a
   * fortnight early only means reassigning them when the fortnight arrives —
   * whoever is free on the day is not knowable today. The assignee is chosen
   * when the work actually starts, which is also when the clock starts.
   */
  async plan(p: Principal, id: string, dto: PlanTask) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canPlan', 'Only the manager of the department doing the work may plan it.');
    this.assertMove(item.status, 'PLANNING');

    const when = new Date(dto.plannedFor);
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('That is not a date.');
    }
    /* Yesterday is not a plan. Today is, because a manager planning this
       morning for this afternoon is the ordinary case. */
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    if (when < startOfToday) {
      throw new BadRequestException('Planning a ticket for a date in the past does not say anything useful.');
    }

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items SET status='PLANNING', planned_for=$2, status_reason=$3,
                             status_changed_at=now(), status_changed_by=$4
          WHERE id=$1`, [id, when, dto.note ?? null, p.id]);
      await writeEvent(c, id, p.id, 'PLANNED', { plannedFor: when.toISOString(), note: dto.note });
    });

    await this.tell([item.requester_id], p, `Planned: ${await reference(id)}`,
      `${p.fullName} planned this for ${when.toLocaleDateString('en-GB', { dateStyle: 'full' })}.`, id);
    return this.detail(p, id);
  }

  /**
   * Park a ticket for a reason.
   *
   * The reason is required by the database as well as here, because "on hold"
   * with no sentence attached is how a queue fills with tickets nobody can
   * explain and nobody dares close.
   */
  async hold(p: Principal, id: string, dto: ReasonOnly) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canHold', 'Only the manager of the department doing the work may put it on hold.');
    this.assertMove(item.status, 'ON_HOLD');

    await tx(async (c) => {
      /* The assignee is released, but remembered.
      
         Released because a held ticket has nobody working on it by definition,
         and a name left on it counts against that person's load for as long as
         it sits there. Remembered because resuming almost always means the same
         person picking up where they left off -- asking who should take a
         ticket that was already somebody's is a question with an obvious answer,
         and the obvious answer should be the default rather than a form. */
      await c.query(
        `UPDATE tk_items SET status='ON_HOLD', status_reason=$2,
                             held_assignee_id = assignee_id,
                             assignee_id=NULL, assigned_at=NULL,
                             due_at=NULL, sla_state='ON_TIME', overdue_since=NULL,
                             status_changed_at=now(), status_changed_by=$3
          WHERE id=$1`, [id, dto.reason, p.id]);
      await writeEvent(c, id, p.id, 'HELD',
        { reason: dto.reason, heldAssigneeId: item.assignee_id });
    });

    const told = [item.requester_id, ...(item.assignee_id ? [item.assignee_id] : [])];
    await this.tell(told, p, `On hold: ${await reference(id)}`,
      `${p.fullName} put this on hold. Reason: ${dto.reason}`, id, 'WARNING');
    return this.detail(p, id);
  }

  /**
   * Refuse a move that the lifecycle does not allow.
   *
   * Every transition goes through here, including the ones a manager makes by
   * dragging a card. The board cannot know which drops are legal without
   * asking, and a drop that is silently undone is worse than one that explains
   * itself — the manager tries again, the same way, and concludes the board is
   * broken.
   */
  private assertMove(from: TaskStatus, to: TaskStatus) {
    if (from === to) return;
    if (!canMove(from, to)) {
      throw new ConflictException(
        `A ticket cannot go from ${readableStatus(from)} to ${readableStatus(to)}.`);
    }
  }

  /**
   * A card dropped on another column.
   *
   * One route rather than the board calling `plan`, `hold`, `assign` and the
   * rest depending on where the card landed — because the board would then hold
   * a second copy of the lifecycle, and two copies of a rule is one rule and
   * one bug waiting.
   *
   * Some drops cannot be completed by a drop alone: planning needs a date,
   * holding needs a reason, assigning needs a person. Rather than inventing
   * values, this refuses and says what is missing, so the board can open the
   * right small dialog and call the proper route. The refusal is the API's
   * answer to "what else do you need", not a failure.
   */
  async move(p: Principal, id: string, dto: MoveTask) {
    const { item, access } = await loadWithAccess(p, id);
    const to = dto.to as TaskStatus;

    /* Who may move this card.
    
       The assignee, because it is their work and the board should let them say
       where it has got to without opening the ticket. The manager of the
       department doing it, because they are answerable for the queue.
    
       Not the manager of the department that *asked*: they can follow it and
       cancel it, but moving somebody else's ticket through somebody else's
       pipeline is not oversight. Checked before the transition table, because
       "that is not yours to move" is the more useful of the two answers. */
    const mayMove = access.isAssignee
      || access.managesDepartment
      || can(p, TASK_PERMISSIONS.MANAGE_ANY);

    if (!mayMove) {
      throw new ForbiddenException(
        access.managesRequestingDepartment
          ? 'Your department asked for this work; another is doing it. You can follow it and cancel it, but not move it through their board.'
          : 'Only the person doing this work, or their manager, may move it.');
    }

    this.assertMove(item.status, to);

    switch (to) {
      /* Parking is the manager's call, even when the assignee may move the
         card. Letting somebody put their own ticket on hold is letting them
         stop their own clock. */
      case 'PLANNING':
        if (!access.managesDepartment && !can(p, TASK_PERMISSIONS.MANAGE_ANY)) {
          throw new ForbiddenException('Planning a ticket is your manager\'s decision.');
        }
        if (!dto.plannedFor) {
          throw new BadRequestException('A planned ticket needs a date. Pick one.');
        }
        return this.plan(p, id, { plannedFor: dto.plannedFor, note: dto.reason });

      case 'ON_HOLD':
        if (!access.managesDepartment && !can(p, TASK_PERMISSIONS.MANAGE_ANY)) {
          throw new ForbiddenException('Putting a ticket on hold is your manager\'s decision.');
        }
        if (!dto.reason?.trim()) {
          throw new BadRequestException('A ticket put on hold needs a reason.');
        }
        return this.hold(p, id, { reason: dto.reason });

      case 'ASSIGNED':
        if (!dto.assigneeId) {
          throw new BadRequestException('Choose who it goes to.');
        }
        return this.assign(p, id, { assigneeId: dto.assigneeId });

      case 'IN_PROGRESS':
        /* A parked ticket has no assignee, so starting it means choosing one.
           The board asks and sends both together rather than refusing and
           telling somebody to go and assign it first -- which was a refusal
           that named the next step instead of taking it. */
        if (!item.assignee_id) {
          /* Resuming a held ticket goes back to whoever had it. They were taken
             off it by the hold, not by a decision that it was not theirs, so
             making somebody choose again is asking a question that has already
             been answered. An explicit assigneeId still wins, for the case
             where it really should change hands. */
          const back = dto.assigneeId ?? item.held_assignee_id;
          if (!back) {
            throw new BadRequestException('Nobody is on this yet. Choose who starts it.');
          }
          return this.assign(p, id, { assigneeId: back });
        }
        return this.start(p, id);

      case 'FOR_REVIEW':
        /* Submitting work needs the account of what was done -- it is what the
           requester reads while reviewing, and it stays in the history. The
           board asks for it the same way it asks for a date or a reason. */
        if (!dto.resolution?.trim()) {
          throw new BadRequestException('Say what was done. The requester reads it when reviewing.');
        }
        return this.resolve(p, id, { resolution: dto.resolution });

      case 'IMPLEMENTATION':
        /* Approving is the requester's judgement of work they asked for. The
           capability says whether this person holds it; the board is allowed
           to offer the gesture and be told no. */
        return this.approveReview(p, id);

      case 'DONE':
        return this.complete(p, id);

      case 'CANCELLED':
        if (!dto.reason?.trim()) {
          throw new BadRequestException('Say why it is being cancelled.');
        }
        return this.cancel(p, id, { reason: dto.reason });

      default:
        throw new ConflictException(
          `${readableStatus(to)} is not a state a card can be moved to.`);
    }
  }

  async transfer(p: Principal, id: string, dto: TransferTask) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canTransfer', 'Only a manager of this department may send it elsewhere.');
    if (dto.departmentId === item.department_id) {
      throw new BadRequestException('It is already with that department.');
    }
    await this.assertDepartmentIsStaffed(dto.departmentId);

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items
            SET department_id = $2, assignee_id = NULL, assigned_at = NULL, assigned_by = NULL,
                status = 'NEW', status_reason = $3, status_changed_at = now(), status_changed_by = $4
          WHERE id = $1`, [id, dto.departmentId, dto.reason, p.id]);

      /* The old department stops seeing it: it turned out not to be theirs.
         Two exceptions. The requester keeps their own ticket, always. And the
         manager who redirected it keeps read access, because the requester
         will ask them where it went and "I can't see it either" is not an
         answer. */
      await c.query(
        `DELETE FROM tk_participants
          WHERE item_id = $1 AND role IN ('ASSIGNEE','CONTRIBUTOR','PAST_ASSIGNEE')`, [id]);
      await addParticipant(c, id, p.id, 'OBSERVER', p.id);
      await writeEvent(c, id, p.id, 'TRANSFERRED',
        { fromDepartmentId: item.department_id, toDepartmentId: dto.departmentId, reason: dto.reason });
    });

    await this.tell([item.requester_id], p, `Redirected: ${await reference(id)}`,
      `${p.fullName} sent it to another department. Reason: ${dto.reason}`, id);
    await this.tell(departmentManagersOf(dto.departmentId), p,
      `Sent to your department: ${await reference(id)}`, dto.reason, id);
    return this.detail(p, id);
  }

  async reject(p: Principal, id: string, dto: ReasonOnly) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canReject',
      'It can only be refused before it is assigned. After that, transfer it or resolve it.');
    await this.close(p, id, 'REJECTED', dto.reason, 'REJECTED');
    await this.tell([item.requester_id], p, `Not accepted: ${await reference(id)}`,
      `${p.fullName} refused it. Reason: ${dto.reason}`, id);
    return this.detail(p, id);
  }

  async cancel(p: Principal, id: string, dto: ReasonOnly) {
    const { access } = await loadWithAccess(p, id);
    assertCan(access, 'canCancel', 'Only the person who raised this may cancel it.');
    await this.close(p, id, 'CANCELLED', dto.reason, 'CANCELLED');
    await this.tellParticipants(id, p, `Cancelled: ${await reference(id)}`,
      `${p.fullName} cancelled it. Reason: ${dto.reason}`);

    /* Dependencies this ticket spawned are another department's work, with
       their own assignee and their own due date. Cancelling somebody else's
       ticket by side effect is not ours to do -- so the person who asked for
       it is told, and decides. */
    const children = await query(
      `SELECT t.id, t.reference, t.requester_id FROM tk_links l
         JOIN tk_items t ON t.id = l.depends_on_item_id
        WHERE l.item_id = $1 AND l.released_at IS NULL AND t.status = ANY($2::text[])`,
      [id, OPEN_STATUSES]);
    for (const child of children) {
      await this.tell([child.requester_id], p,
        `The ticket behind ${child.reference} was cancelled`,
        'The work that needed it has been cancelled. Decide whether this is still required.', child.id);
    }
    return this.detail(p, id);
  }

  async start(p: Principal, id: string) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canWork', 'Only the person it is assigned to may start it.');
    /* Kept for rows assigned before assigning started the work, and for a
       ticket that came back from BLOCKED. Nothing new reaches ASSIGNED. */
    if (item.status !== 'ASSIGNED') throw new ConflictException('It is already under way.');
    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items SET status='IN_PROGRESS', status_changed_at=now(), status_changed_by=$2 WHERE id=$1`,
        [id, p.id]);
      await writeEvent(c, id, p.id, 'STARTED', {});
    });
    return this.detail(p, id);
  }

  async setDue(p: Principal, id: string, dto: SetDue) {
    const { access } = await loadWithAccess(p, id);
    assertCan(access, 'canWork', 'Only the person it is assigned to sets the date.');
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (dueAt && dueAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('A commitment in the past is not a commitment.');
    }
    await tx(async (c) => {
      /* Setting a new date clears the lateness rather than leaving a red badge
         on a ticket that now has a future commitment. The event keeps the
         history, so "this slipped twice" is still answerable. */
      await c.query(
        `UPDATE tk_items SET due_at = $2, sla_state = 'ON_TIME', overdue_since = NULL WHERE id = $1`,
        [id, dueAt]);
      await writeEvent(c, id, p.id, 'DUE_SET', { dueAt });
    });
    await this.tellParticipants(id, p, `Date set on ${await reference(id)}`,
      dueAt ? `${p.fullName} committed to ${dueAt.toISOString()}.` : `${p.fullName} removed the date.`);
    return this.detail(p, id);
  }

  async resolve(p: Principal, id: string, dto: ResolveTask) {
    const { item, access } = await loadWithAccess(p, id);
    /* Checked before the capability, not after. canResolve is false while the
       ticket is BLOCKED -- which is what hides the button -- but somebody who
       reaches the route anyway is usually its assignee, and telling them
       "only the person it is assigned to may resolve it" would be both wrong
       and baffling. They get the dependency by name instead. */
    const blockers = await query(
      `SELECT t.reference, d.name AS department FROM tk_links l
         JOIN tk_items t ON t.id = l.depends_on_item_id
         JOIN core_departments d ON d.id = t.department_id
  LEFT JOIN core_departments rd ON rd.id = t.requester_department_id
        WHERE l.item_id = $1 AND l.link_type='BLOCKED_BY' AND l.released_at IS NULL`, [id]);
    if (blockers.length > 0) {
      throw new ConflictException(
        `Still waiting on ${blockers.map((b) => `${b.reference} (${b.department})`).join(', ')}. Release the dependency first.`);
    }

    assertCan(access, 'canResolve', 'Only the person it is assigned to may submit the work.');

    /* Where finished work goes depends on the ticket, not on who submitted it.
       A fast-tracked ticket has no reviewer, so it moves straight to being
       carried out; everything else waits for the person who asked. */
    const next = nextAfterWork(!!item.fast_track);

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items
            SET status=$4, status_reason=$2, resolved_at=now(), resolved_by=$3,
                implementation_started_at = CASE WHEN $4 = 'IMPLEMENTATION' THEN now() END,
                status_changed_at=now(), status_changed_by=$3
          WHERE id=$1`, [id, dto.resolution, p.id, next]);
      await writeEvent(c, id, p.id,
        next === 'FOR_REVIEW' ? 'SUBMITTED_FOR_REVIEW' : 'IMPLEMENTATION_STARTED',
        { resolution: dto.resolution, fastTrack: !!item.fast_track });
    });

    const ref = await reference(id);
    if (next === 'FOR_REVIEW') {
      /* Emailed, because it asks the requester to do something. A review
         nobody knows is waiting is a ticket that stops here. */
      await this.tell([item.requester_id], p, `Waiting for your review: ${ref}`,
        dto.resolution, id, 'INFO', true);
    } else {
      await this.tell([item.requester_id], p, `Being carried out: ${ref}`,
        `${p.fullName} finished the work and is putting it in place. This ticket was fast-tracked, so it skipped review.`,
        id);
    }
    return this.detail(p, id);
  }

  /**
   * The requester approves the work.
   *
   * Approval does not finish a ticket — it moves it to IMPLEMENTATION, where
   * the assignee puts the thing in place in the real world. That step exists
   * because "the design is approved" and "the design is live" are different
   * days, and a board that cannot tell them apart shows work as done that
   * nobody has yet received.
   */
  async approveReview(p: Principal, id: string) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canApproveReview', 'Only the person who raised it may approve the work.');

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items
            SET status='IMPLEMENTATION', implementation_started_at=now(),
                status_reason=NULL, status_changed_at=now(), status_changed_by=$2
          WHERE id=$1`, [id, p.id]);
      await writeEvent(c, id, p.id, 'REVIEW_APPROVED', {});
    });

    if (item.assignee_id) {
      await this.tell([item.assignee_id], p, `Approved — go ahead: ${await reference(id)}`,
        `${p.fullName} approved the work. Mark it done once it is in place.`, id, 'INFO', true);
    }
    return this.detail(p, id);
  }

  /**
   * The assignee declares the implementation finished. This is the only way a
   * ticket reaches DONE.
   */
  async complete(p: Principal, id: string) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canComplete', 'Only the person carrying it out may mark it done.');

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items
            SET status='DONE', done_at=now(), closed_at=now(), closed_by=$2,
                status_reason=NULL, status_changed_at=now(), status_changed_by=$2
          WHERE id=$1`, [id, p.id]);
      await writeEvent(c, id, p.id, 'DONE', {});
    });

    /* Emailed to the requester. On a fast-tracked ticket this is the first
       they hear of the work being finished, because they never saw it for
       review -- which makes it the one message that must not be missed. */
    await this.tell([item.requester_id], p, `Done: ${await reference(id)}`,
      `${p.fullName} completed it.`, id, 'INFO', true);

    await this.tellParticipants(id, p, `Done: ${await reference(id)}`,
      `${p.fullName} completed it.`);

    /* Anything waiting on this ticket can move again. */
    await this.releaseBlockersOn(p, id);
    return this.detail(p, id);
  }

  /**
   * The requester sends work back.
   *
   * The due date is cleared, not kept. The date was a promise about the work as
   * it was submitted, and that work was refused — leaving it in place would
   * show a ticket as on time against a commitment nobody is holding any more,
   * or overdue against one already met. The assignee sets a new one, and
   * `mustSetNewDueDate` is what tells the screen to insist.
   */
  async rejectReview(p: Principal, id: string, dto: ReasonOnly) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canRejectReview', 'Only the person who raised it may send the work back.');

    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items
            SET status='IN_PROGRESS', status_reason=$2,
                review_rejected_reason=$2, review_rejected_at=now(),
                review_rejection_count = review_rejection_count + 1,
                due_at=NULL, sla_state='ON_TIME', overdue_since=NULL,
                resolved_at=NULL, resolved_by=NULL,
                status_changed_at=now(), status_changed_by=$3
          WHERE id=$1`, [id, dto.reason, p.id]);
      await writeEvent(c, id, p.id, 'REVIEW_REJECTED', { reason: dto.reason });
    });

    if (item.assignee_id) {
      await this.tell([item.assignee_id], p, `Sent back to you: ${await reference(id)}`,
        `${p.fullName} did not accept the work. Reason: ${dto.reason}. Set a new due date to carry on.`,
        id, 'WARNING', true);
    }
    return this.detail(p, id);
  }

  /* `reopen` is gone.
   *
   * It existed because CLOSED was reachable while the requester still
   * disagreed, so there had to be a way back. The review cycle replaces it:
   * work is sent back from FOR_REVIEW as many times as needed, and DONE is
   * only reached after the requester has approved and the assignee has carried
   * it out. A ticket that reaches DONE has been agreed by both, which is
   * exactly the state that should not be reopened -- raise a new ticket, and
   * keep the record of what was actually agreed. */


  async comment(p: Principal, id: string, dto: AddComment) {
    const { access } = await loadWithAccess(p, id);
    assertCan(access, 'canComment', 'You can read this ticket but not add to it.');
    const commentId = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tk_comments (item_id, author_id, body) VALUES ($1,$2,$3) RETURNING id`,
        [id, p.id, dto.body]);
      await writeEvent(c, id, p.id, 'COMMENTED', { preview: dto.body.slice(0, 120) });
      return rows[0].id as string;
    });
    await this.tellParticipants(id, p, `New comment on ${await reference(id)}`,
      `${p.fullName}: ${dto.body.slice(0, 160)}`);
    /* The new comment's id travels back with the ticket. Files are attached to
       a comment after it exists -- the browser posts the words, then uploads
       against this id -- so it needs to know which comment it just wrote. */
    return { ...(await this.detail(p, id)), createdCommentId: commentId };
  }

  async addContributor(p: Principal, id: string, dto: ManageContributor) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canManageContributors',
      'Only a manager of this department brings colleagues in. Ask them if you need help on it.');

    const target = await one<any>(
      `SELECT id, full_name, department_id FROM core_users
        WHERE id=$1 AND deleted_at IS NULL AND status='ACTIVE'`, [dto.userId]);
    if (!target) throw new NotFoundException('That person is not an active employee.');
    if (target.department_id !== item.department_id) {
      throw new BadRequestException(
        `${target.full_name} is not in this department. A ticket is private to the people on it; if their department is needed, raise a dependency.`);
    }

    await tx(async (c) => {
      await addParticipant(c, id, target.id, 'CONTRIBUTOR', p.id);
      await writeEvent(c, id, p.id, 'CONTRIBUTOR_ADDED', { userId: target.id, name: target.full_name });
    });
    await this.tell([target.id], p, `You were added to ${await reference(id)}`,
      `${p.fullName} brought you in. You can read it and comment.`, id);
    return this.detail(p, id);
  }

  async removeContributor(p: Principal, id: string, userId: string) {
    const { access } = await loadWithAccess(p, id);
    assertCan(access, 'canManageContributors', 'Only a manager of this department may remove a contributor.');
    await tx(async (c) => {
      const { rowCount } = await c.query(
        `DELETE FROM tk_participants WHERE item_id=$1 AND user_id=$2 AND role='CONTRIBUTOR'`, [id, userId]);
      if (rowCount > 0) await writeEvent(c, id, p.id, 'CONTRIBUTOR_REMOVED', { userId });
    });
    return this.detail(p, id);
  }

  /**
   * A dependency is an ordinary ticket to another department, plus a link.
   * There is no special path and no special state: the other department gets a
   * normal request, into their normal queue, with their normal manager
   * assigning it. What crosses the wall is what was typed here, which is why
   * the form asks for the requirement in full.
   */
  async addDependency(p: Principal, id: string, dto: AddDependency) {
    const { item, access } = await loadWithAccess(p, id);
    assertCan(access, 'canAddDependency',
      'Only the person it is assigned to, or a manager of this department, may raise a dependency.');
    if (dto.departmentId === item.department_id) {
      throw new BadRequestException(
        'That is your own department. Ask your manager to add a colleague as a contributor instead.');
    }
    await this.assertDepartmentIsStaffed(dto.departmentId);

    const child = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tk_items (title, description, priority, requester_id,
                               requester_department_id, department_id, status_changed_by)
         VALUES ($1,$2,COALESCE($3,'NORMAL'),$4,$5,$6,$4) RETURNING id, reference`,
        [dto.title, dto.description ?? null, dto.priority ?? null, p.id,
         item.department_id, dto.departmentId]);
      const created = rows[0];

      await addParticipant(c, created.id, p.id, 'REQUESTER', p.id);
      await writeEvent(c, created.id, p.id, 'CREATED', { departmentId: dto.departmentId, forItemId: id });

      await c.query(
        `INSERT INTO tk_links (item_id, depends_on_item_id, created_by, response)
         VALUES ($1,$2,$3,'PENDING')`,
        [id, created.id, p.id]);

      /* The clock stops here, and `blocked_at` is what remembers when. The due
         date is kept rather than cleared: it is still the promise, and the time
         spent waiting on somebody else is added back when the block lifts. A
         person should not go overdue for a week because another department was
         slow, and then appear as the problem on their manager's board. */
      await c.query(
        `UPDATE tk_items
            SET status='BLOCKED', blocked_at=now(),
                sla_state='ON_TIME', overdue_since=NULL,
                status_changed_at=now(), status_changed_by=$2
          WHERE id=$1 AND status IN ('ASSIGNED','IN_PROGRESS')`, [id, p.id]);
      await writeEvent(c, id, p.id, 'DEPENDENCY_ADDED',
        { childId: created.id, childReference: created.reference, departmentId: dto.departmentId });
      await writeEvent(c, id, null, 'BLOCKED', { childReference: created.reference });
      return created;
    });

    /* Emailed: another department is being asked for something, and nobody
       there is watching this ticket because it did not exist a moment ago. */
    await this.tell(departmentManagersOf(dto.departmentId), p,
      `New ticket for your department: ${child.reference}`,
      `${p.fullName} needs "${dto.title}". It is blocking their work until it comes back.`,
      child.id, 'INFO', true);
    await this.tell([item.requester_id], p, `Waiting on another department: ${await reference(id)}`,
      'It is blocked until that work comes back. You can see which department and how long it has been waiting.', id);
    /* When a manager raises it, the person whose work just stopped is not the
       one who raised it and would otherwise find out by opening the ticket. */
    if (item.assignee_id) {
      await this.tell([item.assignee_id], p, `Blocked: ${await reference(id)}`,
        `${p.fullName} asked another department for "${dto.title}". It unblocks on its own when that comes back.`, id);
    }
    return this.detail(p, id);
  }

  async removeDependency(p: Principal, id: string, linkId: string) {
    const { access } = await loadWithAccess(p, id);
    assertCan(access, 'canAddDependency',
      'Only the person it is assigned to, or a manager of this department, may drop a dependency.');
    await tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE tk_links SET released_at = now() WHERE id=$1 AND item_id=$2 AND released_at IS NULL`,
        [linkId, id]);
      if (rowCount > 0) await writeEvent(c, id, p.id, 'DEPENDENCY_RELEASED', { linkId });
    });
    await this.unblockIfClear(id, null);
    return this.detail(p, id);
  }

  /* ---------------------------------------------------------- portlets -- */

  async portlet(p: Principal, key: string) {
    const counts = await this.counts(p);
    if (key === 'awaiting-assignment') {
      const list = await this.list(p, { scope: 'queue', pageSize: 5 } as ListTasksQuery);
      return { items: list.items, total: list.total, counts };
    }
    if (key === 'assigned-to-me') {
      const list = await this.list(p, { scope: 'assigned', status: 'open', pageSize: 5 } as ListTasksQuery);
      return { items: list.items, total: list.total, counts };
    }
    if (key === 'my-requests') {
      const list = await this.list(p, { scope: 'requested', status: 'open', pageSize: 5 } as ListTasksQuery);
      return { items: list.items, total: list.total, counts };
    }
    throw new NotFoundException('Unknown portlet');
  }

  /* ----------------------------------------------------------- helpers -- */

  /** Departments with nobody to assign are black holes; never offer one. */
  async departments(p: Principal) {
    const rows = await query(
      `SELECT d.id, d.name, d.name_ar,d
              (SELECT count(*)::int FROM core_department_managers m WHERE m.department_id = d.id) AS managers,
              (d.id = ANY($1::uuid[])) AS i_manage,
              (d.id = $2::uuid) AS mine
         FROM core_departments d WHERE ORDER BY d.name`,
      [p.managedDepartmentIds ?? [], p.departmentId ?? null]);
    return rows
      .filter((r) => r.managers > 0)
      .map((r) => ({ id: r.id, name: r.name, nameAr: r.name_ar, iManage: r.i_manage, isMine: r.mine }));
  }

  /** People a manager may assign to, or bring in as contributors. */
  async assignable(p: Principal, departmentId: string) {
    const rows = await query(
      `SELECT u.id, u.full_name, u.job_title,
              EXISTS (SELECT 1 FROM core_department_managers m
                       WHERE m.department_id = u.department_id AND m.user_id = u.id) AS is_manager
         FROM core_users u
        WHERE u.department_id = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        ORDER BY is_manager DESC, u.full_name`, [departmentId]);
    return rows.map((r) => ({
      id: r.id, name: r.full_name, jobTitle: r.job_title, isManager: r.is_manager,
    }));
  }

  private async assertDepartmentIsStaffed(departmentId: string) {
    const d = await one<any>(
      `SELECT d.name,
              (SELECT count(*)::int FROM core_department_managers m WHERE m.department_id = d.id) AS managers
         FROM core_departments d WHERE d.id = $1`, [departmentId]);
    if (!d) throw new NotFoundException('No such department.');
    if (d.managers === 0) {
      throw new BadRequestException(
        `${d.name} has no manager, so nobody there could pick this up. Ask an administrator to set one first.`);
    }
  }

  private async close(p: Principal, id: string, status: string, reason: string | null, eventType: string) {
    await tx(async (c) => {
      await c.query(
        `UPDATE tk_items SET status=$2, status_reason=$3, closed_at=now(), closed_by=$4,
                             status_changed_at=now(), status_changed_by=$4,
                             sla_state='ON_TIME', overdue_since=NULL
          WHERE id=$1`, [id, status, reason, p.id]);
      await writeEvent(c, id, p.id, eventType, { reason });
    });
    await this.releaseBlockersOn(p, id);
  }

  /**
   * This ticket has finished; anything waiting on it may be able to move.
   * Called on close and on rejection alike, because a refusal is an answer
   * too -- and a worse one to sit waiting for.
   */
  private async releaseBlockersOn(p: Principal, childId: string) {
    const child = await one<any>(
      `SELECT reference, status, status_reason FROM tk_items WHERE id=$1`, [childId]);
    const parents = await query(
      `SELECT l.id AS link_id, l.item_id FROM tk_links l
        WHERE l.depends_on_item_id = $1 AND l.link_type='BLOCKED_BY' AND l.released_at IS NULL`,
      [childId]);

    for (const parent of parents) {
      await query(`UPDATE tk_links SET released_at = now() WHERE id = $1`, [parent.link_id]);
      await this.unblockIfClear(parent.item_id, child);
    }
  }

  private async unblockIfClear(itemId: string, child: any | null) {
    const remaining = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM tk_links
        WHERE item_id=$1 AND link_type='BLOCKED_BY' AND released_at IS NULL`, [itemId]);
    if ((remaining?.n ?? 0) > 0) return;

    const moved = await tx(async (c) => {
      /* The due date moves forward by however long the wait lasted.
      
         The promise was about the work, not about the queue. A person blocked
         for nine days who comes back to a date that passed a week ago has been
         made late by another department's timetable, and no amount of
         explaining removes the red mark from their manager's board. Extending
         keeps the commitment honest: the same amount of working time, starting
         from when they could actually start. */
      const { rowCount } = await c.query(
        `UPDATE tk_items
            SET status='IN_PROGRESS',
                due_at = CASE
                  WHEN due_at IS NOT NULL AND blocked_at IS NOT NULL
                  THEN due_at + (now() - blocked_at)
                  ELSE due_at END,
                blocked_at = NULL,
                status_changed_at=now()
          WHERE id=$1 AND status='BLOCKED'`,
        [itemId]);
      if (rowCount === 0) return false;
      await writeEvent(c, itemId, null, 'UNBLOCKED',
        { childReference: child?.reference, childStatus: child?.status });
      return true;
    });
    if (!moved) return;

    const item = await one<any>(
      `SELECT reference, assignee_id, due_at FROM tk_items WHERE id=$1`, [itemId]);
    if (!item?.assignee_id) return;
    const refused = child?.status === 'REJECTED' || child?.status === 'CANCELLED';

    /* Emailed either way: this is somebody's work becoming possible again, or
       becoming impossible, and both need them to decide what happens next. */
    await this.tell([item.assignee_id], { id: '', fullName: '' } as Principal,
      refused ? `Not going to happen: ${item.reference} is unblocked` : `Unblocked: ${item.reference}`,
      refused
        ? `${child.reference} was ${child.status.toLowerCase()}. Reason: ${child.status_reason ?? 'none given'}. Carry on, or say where it stands.`
        : `The work you were waiting on is done.${item.due_at ? ' Your due date has moved forward by the time you spent waiting — set a new one if it no longer fits.' : ' Set a due date to carry on.'}`,
      itemId, refused ? 'WARNING' : 'INFO', true);
  }

  /* Notification fan-out. Never throws: see the header of this file. */

  private async tellParticipants(id: string, actor: Principal, title: string, body: string, alsoExclude: string[] = []) {
    const rows = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM tk_participants
        WHERE item_id = $1 AND role <> 'OBSERVER'`, [id]);
    const targets = rows.map((r) => r.user_id)
      .filter((u) => u !== actor.id && !alsoExclude.includes(u));
    await this.tellRaw(targets, title, body, id);
  }

  /**
   * Tell people something happened.
   *
   * `alsoEmail` is not a detail — it is the whole policy. Every status change
   * writes a portal notification, because the board should explain itself. Only
   * the ones that need somebody to act, or that they would be wrong not to
   * know, are emailed: assigned to you, sent back to you, gone late, waiting
   * for your review, a department asking something of you, finished.
   *
   * The rest — started, planned, being carried out — stay in the portal. An
   * inbox that receives every transition is an inbox where the important
   * message is filtered away with the rest, and the filter is permanent.
   */
  private async tell(targets: string[] | Promise<string[]>, actor: Principal,
                     title: string, body: string | undefined, id: string,
                     severity: 'INFO' | 'WARNING' = 'INFO',
                     alsoEmail = false) {
    const list = (await targets).filter((u) => u !== actor.id);
    if (!list.length) return;

    const ids = await this.tellRaw(list, title, body ?? '', id, severity);
    if (!alsoEmail) return;

    /* Never awaited into the caller's failure path. A ticket that moved is a
       fact; an email that did not send is a nuisance, and the second must not
       be able to undo the first. */
    void this.emailThose(ids, title, body ?? '', id).catch(() => undefined);
  }

  private async emailThose(
    sent: Array<{ userId: string; notificationId: string | null }>,
    title: string, body: string, itemId: string,
  ): Promise<void> {
    const withIds = sent.filter((x) => x.notificationId);
    if (!withIds.length) return;

    const item = await one<any>(
      `SELECT t.reference, t.title, t.status, t.priority, t.due_at, t.planned_for,
              d.name AS department, rd.name AS requester_department,
              u.full_name AS requester_name
         FROM tk_items t
         JOIN core_departments d ON d.id = t.department_id
    LEFT JOIN core_departments rd ON rd.id = t.requester_department_id
         JOIN core_users u ON u.id = t.requester_id
        WHERE t.id = $1`, [itemId]);
    if (!item) return;

    const people = await query<{ id: string; email: string }>(
      `SELECT id, email FROM core_users
        WHERE id = ANY($1) AND deleted_at IS NULL AND status = 'ACTIVE'`,
      [withIds.map((x) => x.userId)]);

    const mail = ticketMail({
      reference: item.reference, title: item.title, status: item.status,
      priority: item.priority, department: item.department,
      requesterDepartment: item.requester_department, requesterName: item.requester_name,
      dueAt: item.due_at, plannedFor: item.planned_for,
      heading: title, message: body,
      url: `${config.portalUrl}/tasks/${itemId}`,
    });

    await Promise.all(withIds.map(async (x) => {
      const person = people.find((u) => u.id === x.userId);
      if (!person?.email) return;
      await this.mailer.deliver(
        x.notificationId!, person.email, mail.subject, mail.html, mail.text,
      ).catch(() => undefined);
    }));
  }

  /** Returns what it wrote, so the caller can attach an email to each row and
   *  record whether that email arrived. */
  private async tellRaw(userIds: string[], title: string, body: string, id: string,
                        severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO') {
    const written: Array<{ userId: string; notificationId: string | null }> = [];
    for (const userId of new Set(userIds)) {
      try {
        const notificationId = await this.notifications
          .notify(userId, MODULE_KEY, title, body, severity, `/tasks/${id}`);
        written.push({ userId, notificationId });
      } catch (e) {
        this.log.warn(`notification to ${userId} failed: ${(e as Error).message}`);
        written.push({ userId, notificationId: null });
      }
    }
    return written;
  }
}

/* --------------------------------------------------------------- shared -- */

async function reference(id: string): Promise<string> {
  const r = await one<{ reference: string }>(`SELECT reference FROM tk_items WHERE id=$1`, [id]);
  return r?.reference ?? 'a ticket';
}

async function departmentManagersOf(departmentId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT m.user_id FROM core_department_managers m
       JOIN core_users u ON u.id = m.user_id
      WHERE m.department_id = $1 AND u.deleted_at IS NULL AND u.status='ACTIVE'`, [departmentId]);
  return rows.map((r) => r.user_id);
}

async function coManagers(departmentId: string, exceptUserId: string): Promise<string[]> {
  return (await departmentManagersOf(departmentId)).filter((u) => u !== exceptUserId);
}

async function addParticipant(c: any, itemId: string, userId: string,
                              role: ParticipantRole, addedBy: string) {
  await c.query(
    `INSERT INTO tk_participants (item_id, user_id, role, added_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [itemId, userId, role, addedBy]);
}


function parseStatuses(value?: string): string[] | null {
  if (!value) return null;
  if (value === 'open') return OPEN_STATUSES;
  if (value === 'closed') return CLOSED_STATUSES;
  const wanted = value.split(',').map((s) => s.trim().toUpperCase())
    .filter((s) => [...OPEN_STATUSES, ...CLOSED_STATUSES].includes(s));
  return wanted.length > 0 ? wanted : null;
}

function shapeItem(r: any) {
  return {
    id: r.id, reference: r.reference, title: r.title, description: r.description,
    priority: r.priority, status: r.status, statusReason: r.status_reason,
    statusChangedAt: r.status_changed_at,
    departmentId: r.department_id, department: r.department_name, departmentAr: r.department_name_ar,
    requesterDepartmentId: r.requester_department_id,
    requesterDepartment: r.requester_department_name,
    requesterId: r.requester_id, requesterName: r.requester_name, requesterTitle: r.requester_title,
    assigneeId: r.assignee_id, assigneeName: r.assignee_name, assigneeTitle: r.assignee_title,
    dueAt: r.due_at, slaState: r.sla_state, overdueSince: r.overdue_since,
    assignedAt: r.assigned_at, resolvedAt: r.resolved_at, closedAt: r.closed_at,
    fastTrack: r.fast_track === true,
    plannedFor: r.planned_for ?? null,
    reviewRejectedReason: r.review_rejected_reason ?? null,
    reviewRejectionCount: r.review_rejection_count ?? 0,
    reopenedCount: r.reopened_count, createdAt: r.created_at, updatedAt: r.updated_at,
    commentCount: r.comment_count ?? 0, openBlockerCount: r.open_blocker_count ?? 0,
  };
}

/** The capability flags the portal renders buttons from. The server decides
 *  what is possible; the screen never re-derives the rule and gets it wrong. */
function publicAccess(a: TaskAccess) {
  return {
    roles: a.roles, managesDepartment: a.managesDepartment,
    managesRequestingDepartment: a.managesRequestingDepartment,
    isRequester: a.isRequester, isAssignee: a.isAssignee,
    canEditRequest: a.canEditRequest, canCancel: a.canCancel,
    canAssign: a.canAssign, canTransfer: a.canTransfer, canReject: a.canReject,
    canManageContributors: a.canManageContributors,
    canPlan: a.canPlan, canHold: a.canHold,
    canWork: a.canWork, canAddDependency: a.canAddDependency, canResolve: a.canResolve,
    canApproveReview: a.canApproveReview, canRejectReview: a.canRejectReview,
    canComplete: a.canComplete, mustSetNewDueDate: a.mustSetNewDueDate,
    canComment: a.canComment,
  };
}