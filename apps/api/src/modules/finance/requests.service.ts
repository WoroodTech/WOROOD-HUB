/**
 * Finance requests: creating them, and moving them along the chain.
 *
 * The rules themselves live in `workflow.ts` and are tested on their own. This
 * service is about rows: reading what a person is allowed to read, writing what
 * they are allowed to write, and keeping the approval trail honest.
 *
 * Two habits run through it:
 *
 * Every decision is taken inside a transaction with the request locked, because
 * two managers pressing Approve at the same moment must not produce two trail
 * entries and one confused state. The legacy app used a script-wide lock for
 * this, which worked because only one script ever ran; a row lock is the same
 * idea without the single-threading.
 *
 * Nothing is trusted from the browser about who may do what. The decision
 * helpers take the principal and the request, and the controller's permission
 * decorator is a first gate rather than the only one.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Principal, can } from '../../common/auth';
import { one, query, tx } from '../../common/db';
import { AuditService, NotificationsService } from '../../core/core.module';
import { NotificationMailer } from '../../core/notifications.controller';
import { awaitingDecisionMail, refusedMail } from './finance-mail';
import { config } from '../../common/config';
import {
  canDecide, canDelete, canEditDirectly, firstState, labelFor, LABEL_AR,
  makeReference, nextState, stepOf, type ApprovalState, type PaymentState,
} from './workflow';
import { FormError, fieldsFor, validateRequest } from './request-form';
import { lensFor, project, type Lens } from './projection';

const MANAGE = 'finance.request.manage';
const REPORT = 'finance.report.view';
const PURCHASES = 'finance.purchases.decide';

/* What Purchases classifies spending into. The same two the Purchases
   department's own request types are, because a priced request becomes a
   Purchases Log row in the legacy app and feeds one of its two cash-flow
   columns. */
const PURCHASE_TYPES = ['Petty Cash', 'Vendors Payments'];

@Injectable()
export class FinanceRequestsService {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    /* Optional: the module works without it, and a server with no mail
       configured should still run the approval chain. */
    private readonly mailer?: NotificationMailer,
  ) {}

  /**
   * Send one email alongside a bell notification.
   *
   * Never allowed to fail the thing it is reporting: the decision is already
   * committed and is the part that mattered. A mail server being down is a log
   * line, not a lost approval.
   */
  private async alsoEmail(
    userId: string, notificationId: string | null,
    mail: { subject: string; html: string; text: string },
  ) {
    if (!this.mailer || !config.mail.enabled || !notificationId) return;
    try {
      const person = await one<any>(
        `SELECT email FROM core_users WHERE id=$1 AND deleted_at IS NULL`, [userId]);
      if (!person?.email) return;
      await this.mailer.deliver(notificationId, person.email,
        mail.subject, mail.html, mail.text);
    } catch (e: any) {
      this.log.warn(`could not email ${userId}: ${e?.message ?? e}`);
    }
  }

  /* ------------------------------------------------------------ config -- */

  /**
   * Everything the request form needs, for the one department this person can
   * raise a request for: their own.
   *
   * There is no department picker. In the legacy app each department has its
   * own page behind its own link, so a Marketing employee cannot raise a Tech
   * request -- not because it is forbidden, but because there is nowhere to do
   * it. Offering a list here would have invented a capability nobody asked for
   * and nobody wants.
   *
   * The fields the form shows are computed here too, from the same function
   * the server validates with, so the two cannot disagree about what is being
   * asked for.
   */
  async requestForm(p: Principal) {
    if (!p.departmentId) return { department: null, banks: [], fields: null };

    const r = await one<any>(
      `SELECT f.department_id, f.page_key, f.code, f.route, f.lite,
              f.request_types, f.placeholder, f.placeholder_ar,
              d.name, d.name_ar
         FROM fin_departments f
         JOIN core_departments d ON d.id = f.department_id
        WHERE f.department_id = $1 AND f.active`, [p.departmentId]);

    if (!r) return { department: null, banks: [], fields: null };

    const banks = await query<any>(
      `SELECT name, name_ar FROM fin_banks WHERE active ORDER BY position, name`);

    const base = { lite: r.lite, requestTypes: r.request_types ?? [] };
    return {
      department: {
        id: r.department_id, pageKey: r.page_key, code: r.code,
        name: r.name, nameAr: r.name_ar,
        route: r.route, lite: r.lite,
        requestTypes: r.request_types ?? [],
        placeholder: r.placeholder, placeholderAr: r.placeholder_ar,
      },
      banks: banks.map((b) => ({ name: b.name, nameAr: b.name_ar })),
      /* Both shapes, because a `choice` department switches between them as
         the requester picks, and asking the server again on every click would
         make the form stutter. */
      fields: {
        finance: fieldsFor({ ...base, route: 'finance' }),
        purchases: fieldsFor({ ...base, route: 'purchases' }),
      },
    };
  }

  private async departmentConfig(departmentId: string) {
    const row = await one<any>(
      `SELECT f.*, d.name FROM fin_departments f
         JOIN core_departments d ON d.id = f.department_id
        WHERE f.department_id = $1 AND f.active`, [departmentId]);
    if (!row) {
      throw new BadRequestException('That department does not raise finance requests.');
    }
    return row;
  }

  /* ------------------------------------------------------------ writing -- */

  /**
   * Raise a request.
   *
   * The route is resolved here rather than taken from the browser: a `choice`
   * department's member picks between Finance and Purchases, and everybody else
   * gets what their department's configuration says. Letting the client send a
   * route would let it send `finance` for a department that must go through
   * Purchases.
   */
  async create(p: Principal, dto: {
    type?: string; description: string; moreDetails?: string;
    dueDate: string; requestedAmount?: number;
    paymentMethod?: string; accountNumber?: string;
    bankName?: string; beneficiaryName?: string;
    sendToPurchases?: boolean; submit?: boolean;
  }) {
    /* The department is the requester's own, always. In the legacy app each
       department has its own page reached by its own link, so raising a
       request for somebody else's department is not something that can be
       expressed -- and it should not become possible here just because the
       portal happens to know about all nine. */
    if (!p.departmentId) {
      throw new BadRequestException(
        'You are not in a department yet, so there is nobody to approve a request. '
        + 'Ask an administrator to add you to one.');
    }
    const cfg = await this.departmentConfig(p.departmentId);

    const route: 'finance' | 'purchases' =
      cfg.route === 'choice' ? (dto.sendToPurchases ? 'purchases' : 'finance')
      : cfg.route === 'purchases' ? 'purchases'
      : 'finance';

    /* One place decides what a request must contain, and it depends on where
       the request is going rather than on who is asking. A Marketing request
       sent to Purchases carries no amount, exactly as an Office one does. */
    let clean;
    try {
      clean = validateRequest(dto, {
        route, lite: cfg.lite, requestTypes: cfg.request_types ?? [],
      });
    } catch (e) {
      if (e instanceof FormError) throw new BadRequestException(e.message);
      throw e;
    }

    const managerIds = await this.managersOf(p.departmentId);
    const state: ApprovalState = dto.submit === false
      ? 'DRAFT'
      : firstState({ requesterId: p.id, route }, managerIds);

    const reference = makeReference(cfg.code, () => randomUUID().replace(/-/g, ''));

    const row = await one<any>(
      `INSERT INTO fin_requests
         (reference, department_id, requester_id, requester_department_id,
          charged_to_department_id, type, description, more_details, due_date,
          requested_amount, payment_method, payment_details,
          bank_name, account_number, beneficiary_name, route, approval_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [reference, p.departmentId, p.id, p.departmentId,
       /* Charged to the asking department until Purchases takes it over, which
          is the moment a lite department's spending becomes Purchases' line in
          the cash flow. */
       p.departmentId,
       clean.type, clean.description, clean.moreDetails, clean.dueDate,
       clean.requestedAmount, clean.paymentMethod, clean.paymentDetails,
       clean.bankName, clean.accountNumber, clean.beneficiaryName,
       route, state]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: 'request.create',
      entityType: 'fin_request', entityId: row.id,
      payload: { reference, route, state },
    });

    if (state !== 'DRAFT') await this.tellWhoeverIsNext(row);
    return this.view(p, row);
  }

  /**
   * Submit a draft.
   *
   * Separate from creation so a long request can be written in more than one
   * sitting without anyone being asked to approve a half-finished one.
   */
  async submit(p: Principal, id: string) {
    const row = await this.load(id);
    if (row.requester_id !== p.id) {
      throw new ForbiddenException('Only the person who raised it can submit it.');
    }
    if (row.approval_state !== 'DRAFT') {
      throw new BadRequestException('This request has already been submitted.');
    }

    const managerIds = await this.managersOf(row.department_id);
    const state = firstState({ requesterId: p.id, route: row.route }, managerIds);
    const updated = await one<any>(
      `UPDATE fin_requests SET approval_state=$2 WHERE id=$1 RETURNING *`, [id, state]);

    await this.tellWhoeverIsNext(updated);
    return this.view(p, updated);
  }

  /**
   * Change a request in place.
   *
   * Only the person who raised it, and only while it is still Open -- before
   * anybody has approved anything. After that the amount has been agreed by
   * everyone who decided it, and changing it is a new decision for all of them:
   * that is an edit request, which arrives in phase 3.
   */
  async update(p: Principal, id: string, dto: Record<string, any>) {
    const row = await this.load(id);
    const shape = this.shapeOf(row);

    if (!canEditDirectly(p, shape)) {
      if (row.requester_id !== p.id) {
        throw new ForbiddenException('Only the person who raised it can change it.');
      }
      throw new BadRequestException(
        'This request has been approved. Ask for a change instead, and say why.');
    }

    if (dto.requestedAmount !== undefined && !(dto.requestedAmount > 0)) {
      throw new BadRequestException('The amount must be more than zero.');
    }

    const updated = await one<any>(
      `UPDATE fin_requests SET
         description      = COALESCE($2, description),
         more_details     = COALESCE($3, more_details),
         due_date         = COALESCE($4, due_date),
         requested_amount = COALESCE($5, requested_amount),
         payment_method   = COALESCE($6, payment_method),
         payment_details  = COALESCE($7, payment_details),
         type             = COALESCE($8, type)
       WHERE id = $1 RETURNING *`,
      [id, dto.description ?? null, dto.moreDetails ?? null, dto.dueDate ?? null,
       dto.requestedAmount ?? null, dto.paymentMethod ?? null,
       dto.paymentDetails ?? null, dto.type ?? null]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: 'request.update',
      entityType: 'fin_request', entityId: id, payload: dto,
    });
    return this.view(p, updated);
  }

  /**
   * Approve or reject, at whichever step the request is waiting on.
   *
   * One endpoint for all three steps rather than one each. Who may act is
   * decided by the state the request is actually in, so a person with several
   * permissions cannot take a step that belongs to somebody else -- and the
   * check is the same one wherever the request came from.
   */
  async decide(
    p: Principal, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string,
    pricing?: {
      type?: string; requestedAmount?: number; vendorName?: string;
      paymentMethod?: string; accountNumber?: string;
      bankName?: string; beneficiaryName?: string;
    },
  ) {
    const result = await tx(async (c) => {
      /* Locked for the duration: two managers pressing Approve together would
         otherwise both read MANAGER_PENDING and both write a trail entry. */
      const { rows } = await c.query(
        `SELECT * FROM fin_requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id]);
      const row = rows[0];
      if (!row) throw new NotFoundException('No such request.');

      const shape = this.shapeOf(row);
      const step = stepOf(shape.approvalState);
      if (!step) {
        throw new BadRequestException(
          row.approval_state === 'DRAFT'
            ? 'This request has not been submitted yet.'
            : 'This request has already been decided.');
      }
      if (!canDecide(p, shape)) {
        throw new ForbiddenException(
          row.requester_id === p.id
            ? 'You cannot decide your own request.'
            : 'This request is not waiting for you.');
      }
      if (decision === 'REJECTED' && !reason?.trim()) {
        throw new BadRequestException('Say why it is being rejected.');
      }

      const state: ApprovalState = decision === 'REJECTED'
        ? 'REJECTED' : nextState(shape.approvalState, row.route);

      const column = step === 'MANAGER' ? 'manager'
                   : step === 'PURCHASES' ? 'purchases' : 'finance';

      /* Purchases does not merely wave a request through: it says what the
         thing costs, what kind of spending it is and where the money goes.
         Without that the request reaches Finance meaning nothing -- an
         approval with no amount is not something anybody can pay. */
      let priced: Record<string, any> | null = null;
      if (step === 'PURCHASES' && decision === 'APPROVED') {
        priced = this.validatePricing(pricing, row);
      }

      const { rows: out } = await c.query(
        `UPDATE fin_requests SET
           approval_state = $2,
           ${column}_decided_by_id = $3,
           ${column}_decided_at = now(),
           rejected_by_id = CASE WHEN $2 = 'REJECTED' THEN $3 ELSE rejected_by_id END,
           rejected_at = CASE WHEN $2 = 'REJECTED' THEN now() ELSE rejected_at END,
           rejection_reason = CASE WHEN $2 = 'REJECTED' THEN $4 ELSE rejection_reason END,
           type             = COALESCE($5, type),
           requested_amount = COALESCE($6, requested_amount),
           payment_method   = COALESCE($7, payment_method),
           payment_details  = COALESCE($8, payment_details),
           bank_name        = COALESCE($9, bank_name),
           account_number   = COALESCE($10, account_number),
           beneficiary_name = COALESCE($11, beneficiary_name),
           vendor_name      = COALESCE($12, vendor_name),
           priced_by_id     = CASE WHEN $5 IS NULL THEN priced_by_id ELSE $3 END,
           priced_at        = CASE WHEN $5 IS NULL THEN priced_at ELSE now() END,
           /* Priced by Purchases means charged to Purchases: this is what the
              legacy app expressed by moving the row into the Purchases Log. */
           charged_to_department_id = CASE WHEN $5 IS NULL THEN charged_to_department_id
                                          ELSE $13 END
         WHERE id = $1 RETURNING *`,
        [id, state, p.id, reason ?? null,
         priced?.type ?? null, priced?.requestedAmount ?? null,
         priced?.paymentMethod ?? null, priced?.paymentDetails ?? null,
         priced?.bankName ?? null, priced?.accountNumber ?? null,
         priced?.beneficiaryName ?? null, priced?.vendorName ?? null,
         priced ? p.departmentId : null]);

      /* Appended, never updated: a request rejected, re-raised and approved
         should not look like one approved first time. */
      await c.query(
        `INSERT INTO fin_request_approvals
           (request_id, step, decision, decided_by_id, reason, amount_at_decision)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, step, decision, p.id, reason ?? null, row.requested_amount]);

      if (reason?.trim()) {
        await c.query(
          `INSERT INTO fin_request_notes (request_id, author_id, body) VALUES ($1,$2,$3)`,
          [id, p.id, reason.trim()]);
      }
      return out[0];
    });

    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: `request.${decision.toLowerCase()}`,
      entityType: 'fin_request', entityId: id,
      payload: { reference: result.reference, state: result.approval_state },
    });

    await this.tellTheRequester(result, decision, p);
    if (decision === 'APPROVED') await this.tellWhoeverIsNext(result);

    return this.view(p, result);
  }

  async remove(p: Principal, id: string) {
    const row = await this.load(id);
    if (!canDelete(p, this.shapeOf(row))) {
      throw new ForbiddenException(
        row.payment_state !== 'UNPAID'
          ? 'A request that has been paid cannot be deleted.'
          : 'You cannot delete this request.');
    }
    await query(
      `UPDATE fin_requests SET deleted_at=now(), deleted_by_id=$2 WHERE id=$1`, [id, p.id]);
    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: 'request.delete',
      entityType: 'fin_request', entityId: id, payload: { reference: row.reference },
    });
    return { removed: true };
  }

  /* ------------------------------------------------------------ reading -- */

  /**
   * What a person may see.
   *
   * Three widening circles: own requests always; a manager's departments; and
   * everything for Finance and for read-only Top Management. The projection
   * that decides which *fields* come back is phase 2 -- this is only about
   * which rows.
   */
  private visibility(p: Principal): { sql: string; params: any[] } {
    const managed = p.managedDepartmentIds ?? [];
    const financeEyes = can(p, MANAGE) || can(p, REPORT) || can(p, PURCHASES);

    /* A request still with its department manager has not left the department
       yet, and neither has a draft. Finance seeing either would mean seeing
       spending the department has not finished deciding whether to ask for --
       and would fill the Finance list with requests nobody has committed to.
       So the finance permissions are broad, but they begin where the
       department's own step ends.
    
       Own requests and a manager's own departments are always visible, which
       is what lets the requester watch his draft and the manager see what is
       waiting for him. */
    const departmentPrivate = `r.approval_state NOT IN ('DRAFT', 'MANAGER_PENDING')`;

    if (financeEyes) {
      if (managed.length) {
        return {
          sql: `(${departmentPrivate} OR r.requester_id = $1 OR r.department_id = ANY($2::uuid[]))`,
          params: [p.id, managed],
        };
      }
      return { sql: `(${departmentPrivate} OR r.requester_id = $1)`, params: [p.id] };
    }

    if (managed.length) {
      return {
        sql: `(r.requester_id = $1
               OR (r.department_id = ANY($2::uuid[]) AND r.approval_state <> 'DRAFT'))`,
        params: [p.id, managed],
      };
    }
    /* Everyone else sees their own, drafts included -- a draft is a private
       note to yourself until you submit it. */
    return { sql: 'r.requester_id = $1', params: [p.id] };
  }

  async list(p: Principal, opts: {
    mine?: boolean; departmentId?: string; state?: string;
    limit?: number; offset?: number;
  } = {}) {
    const v = this.visibility(p);
    const params: any[] = [...v.params];
    const where: string[] = ['r.deleted_at IS NULL', v.sql];

    if (opts.mine) { params.push(p.id); where.push(`r.requester_id = $${params.length}`); }
    if (opts.departmentId) {
      params.push(opts.departmentId); where.push(`r.department_id = $${params.length}`);
    }
    if (opts.state === 'open') where.push(`r.approval_state IN
      ('MANAGER_PENDING','PURCHASES_PENDING','FINANCE_PENDING')`);
    if (opts.state === 'approved') where.push(`r.approval_state = 'APPROVED'`);
    if (opts.state === 'rejected') where.push(`r.approval_state = 'REJECTED'`);

    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    params.push(limit, offset);

    const rows = await query<any>(
      `SELECT r.*, u.full_name AS requester_name, d.name AS department_name,
              d.name_ar AS department_name_ar, f.lite AS department_is_lite
         FROM fin_requests r
         LEFT JOIN core_users u ON u.id = r.requester_id
         JOIN core_departments d ON d.id = r.department_id
         LEFT JOIN fin_departments f ON f.department_id = r.department_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    const total = await one<any>(
      `SELECT count(*) AS n FROM fin_requests r WHERE ${where.join(' AND ')}`,
      params.slice(0, params.length - 2));

    return {
      requests: await Promise.all(rows.map((r) => this.view(p, r))),
      total: Number(total?.n ?? 0),
    };
  }

  /**
   * What is waiting for this person to decide.
   *
   * Asked as three separate conditions rather than one clever query, because
   * the three steps have genuinely different rules and a union of them is
   * easier to read -- and to correct -- than a disjunction of joins.
   */
  async approvalsQueue(p: Principal) {
    const clauses: string[] = [];
    const params: any[] = [p.id];

    const managed = p.managedDepartmentIds ?? [];
    if (managed.length) {
      params.push(managed);
      clauses.push(`(r.approval_state = 'MANAGER_PENDING'
                     AND r.department_id = ANY($${params.length}::uuid[]))`);
    }
    if (can(p, PURCHASES)) clauses.push(`r.approval_state = 'PURCHASES_PENDING'`);
    if (can(p, MANAGE)) clauses.push(`r.approval_state = 'FINANCE_PENDING'`);

    if (!clauses.length) return { requests: [], total: 0 };

    const rows = await query<any>(
      `SELECT r.*, u.full_name AS requester_name, d.name AS department_name,
              d.name_ar AS department_name_ar, f.lite AS department_is_lite
         FROM fin_requests r
         LEFT JOIN core_users u ON u.id = r.requester_id
         JOIN core_departments d ON d.id = r.department_id
         LEFT JOIN fin_departments f ON f.department_id = r.department_id
        WHERE r.deleted_at IS NULL
          AND (${clauses.join(' OR ')})
          -- never your own, at any step
          AND r.requester_id <> $1
        ORDER BY r.due_date, r.created_at`, params);

    return {
      requests: await Promise.all(rows.map((r) => this.view(p, r))),
      total: rows.length,
    };
  }

  async get(p: Principal, id: string) {
    const row = await one<any>(
      `SELECT r.*, u.full_name AS requester_name, d.name AS department_name,
              d.name_ar AS department_name_ar, f.lite AS department_is_lite
         FROM fin_requests r
         LEFT JOIN core_users u ON u.id = r.requester_id
         JOIN core_departments d ON d.id = r.department_id
         LEFT JOIN fin_departments f ON f.department_id = r.department_id
        WHERE r.id = $1 AND r.deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('No such request.');

    /* The same rule as the list, so a request that is not in somebody's list
       cannot be opened by guessing its address either. */
    const own = row.requester_id === p.id;
    const managesIt = (p.managedDepartmentIds ?? []).includes(row.department_id);
    const departmentPrivate =
      row.approval_state === 'DRAFT' || row.approval_state === 'MANAGER_PENDING';
    const financeEyes = can(p, MANAGE) || can(p, REPORT) || can(p, PURCHASES);

    const maySee = own
      || (managesIt && row.approval_state !== 'DRAFT')
      || (financeEyes && !departmentPrivate);
    if (!maySee) throw new NotFoundException('No such request.');

    return {
      ...(await this.view(p, row)),
      approvals: await this.trail(id),
      notes: await this.notes(p, id),
    };
  }

  private async trail(id: string) {
    const rows = await query<any>(
      `SELECT a.step, a.decision, a.reason, a.created_at, a.amount_at_decision,
              u.full_name AS decided_by_name
         FROM fin_request_approvals a
         JOIN core_users u ON u.id = a.decided_by_id
        WHERE a.request_id = $1 ORDER BY a.created_at`, [id]);
    return rows.map((a) => ({
      step: a.step, decision: a.decision, reason: a.reason,
      decidedBy: a.decided_by_name,
      amountAtDecision: a.amount_at_decision === null ? null : Number(a.amount_at_decision),
      at: new Date(a.created_at).toISOString(),
    }));
  }

  async notes(p: Principal, id: string) {
    /* Internal notes are for Finance and Purchases to talk among themselves.
       The legacy app rewrote note text for departments that must not see
       money, which lost the real note; keeping them as separate rows means the
       note survives and simply is not shown. */
    const internalToo = can(p, MANAGE) || can(p, PURCHASES) || can(p, REPORT);
    const rows = await query<any>(
      `SELECT n.id, n.body, n.internal, n.created_at, u.full_name AS author_name
         FROM fin_request_notes n
         JOIN core_users u ON u.id = n.author_id
        WHERE n.request_id = $1 AND n.deleted_at IS NULL
          AND ($2::boolean OR NOT n.internal)
        ORDER BY n.created_at`, [id, internalToo]);
    return rows.map((n) => ({
      id: n.id, body: n.body, internal: n.internal,
      author: n.author_name, at: new Date(n.created_at).toISOString(),
    }));
  }

  async addNote(p: Principal, id: string, body: string, internal = false) {
    const row = await this.load(id);
    if (internal && !(can(p, MANAGE) || can(p, PURCHASES))) {
      throw new ForbiddenException('Only Finance and Purchases can leave an internal note.');
    }
    const text = body.trim();
    if (!text) throw new BadRequestException('Write something first.');

    const note = await one<any>(
      `INSERT INTO fin_request_notes (request_id, author_id, body, internal)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [id, p.id, text, internal]);
    return {
      id: note.id, body: text, internal,
      author: p.fullName, at: new Date(note.created_at).toISOString(),
    };
  }

  /**
   * What Purchases must supply when it approves.
   *
   * The same rules the request form applies when a department prices its own
   * spending -- a type, a positive amount, a way to send the money, and a
   * beneficiary for a bank transfer -- because it is the same question being
   * answered by somebody else. Validating it here rather than trusting the
   * screen means a request cannot leave Purchases half-priced.
   */
  private validatePricing(pricing: any, row: any): Record<string, any> {
    if (!pricing) {
      throw new BadRequestException(
        'Say what this costs and how it should be paid before approving it.');
    }
    const cfg = { route: 'finance' as const, lite: false, requestTypes: PURCHASE_TYPES };
    try {
      const clean = validateRequest({
        /* The description and dates are the department's and are not being
           re-asked; only the pricing half is checked. */
        description: row.description,
        moreDetails: row.more_details ?? 'priced by Purchases',
        dueDate: row.due_date instanceof Date
          ? row.due_date.toISOString().slice(0, 10) : String(row.due_date),
        type: pricing.type,
        requestedAmount: pricing.requestedAmount,
        paymentMethod: pricing.paymentMethod,
        accountNumber: pricing.accountNumber,
        bankName: pricing.bankName,
        beneficiaryName: pricing.beneficiaryName,
      }, cfg);

      return {
        type: clean.type,
        requestedAmount: clean.requestedAmount,
        paymentMethod: clean.paymentMethod,
        paymentDetails: clean.paymentDetails,
        bankName: clean.bankName,
        accountNumber: clean.accountNumber,
        beneficiaryName: clean.beneficiaryName,
        vendorName: (pricing.vendorName ?? '').trim() || null,
      };
    } catch (e) {
      if (e instanceof FormError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /**
   * Why no email arrived.
   *
   * Five things have to line up, and from the outside every failure looks the
   * same -- nothing in the inbox. This reports each separately, and optionally
   * sends a real message so the answer is what SES actually said rather than
   * what ought to happen.
   */
  async mailCheck(p: Principal, to?: string) {
    const holders = await query<{ id: string; full_name: string; email: string }>(
      `SELECT DISTINCT u.id, u.full_name, u.email FROM core_users u
         JOIN core_user_roles ur ON ur.user_id = u.id
         JOIN core_role_permissions rp ON rp.role_id = ur.role_id
         JOIN core_permissions p2 ON p2.id = rp.permission_id
        WHERE p2.key = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
      [MANAGE]);

    const managers = await query<{ department: string; full_name: string; email: string }>(
      `SELECT d.name AS department, u.full_name, u.email
         FROM core_department_managers m
         JOIN core_users u ON u.id = m.user_id
         JOIN core_departments d ON d.id = m.department_id
        WHERE u.deleted_at IS NULL AND u.status = 'ACTIVE'
        ORDER BY d.name`);

    const result: Record<string, unknown> = {
      mailEnabled: config.mail.enabled,
      from: config.mail.from || '(not set)',
      /* The quiet one: an email that arrives with a link to localhost is worse
         than no email, because it looks like it worked. */
      portalOrigin: config.portalOrigin,
      portalOriginLooksReal: !/localhost|127\.0\.0\.1/.test(config.portalOrigin),
      mailerWired: !!this.mailer,
      /* Nobody holding the permission means nobody is in the list to email,
         however well the rest of it works. */
      financeApprovers: holders.map((h) => ({
        name: h.full_name, email: h.email, hasAddress: !!h.email,
      })),
      departmentManagers: managers.map((m) => ({
        department: m.department, name: m.full_name,
        email: m.email, hasAddress: !!m.email,
      })),
    };

    if (to) {
      if (!this.mailer) {
        result.testSend = { sent: false, error: 'the mailer is not available' };
      } else {
        const id = await this.notifications.notify(
          p.id, 'finance', 'Mail check', 'A test from the Finance module.', 'INFO');
        try {
          await this.mailer.deliver(id ?? 'mail-check', to,
            'WOROOD HUB — mail check',
            '<p>If you are reading this, Finance emails will reach you.</p>',
            'If you are reading this, Finance emails will reach you.');
          result.testSend = { sent: true, to };
        } catch (e: any) {
          result.testSend = { sent: false, to, error: e?.message ?? String(e) };
        }
      }
    }
    return result;
  }

  /* ------------------------------------------------------------ helpers -- */

  private async load(id: string) {
    const row = await one<any>(
      `SELECT * FROM fin_requests WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('No such request.');
    return row;
  }

  private shapeOf(row: any) {
    return {
      requesterId: row.requester_id,
      departmentId: row.department_id,
      route: row.route as 'finance' | 'purchases',
      approvalState: row.approval_state as ApprovalState,
      paymentState: row.payment_state as PaymentState,
    };
  }

  private async managersOf(departmentId: string): Promise<string[]> {
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM core_department_managers WHERE department_id = $1`,
      [departmentId]);
    return rows.map((r) => r.user_id);
  }

  /**
   * Which departments must never see money.
   *
   * Cached for the life of the process: it is nine rows that change when
   * somebody reorganises the company, and the alternative was reading it from
   * whatever row happened to be at hand -- which is how the privacy rule
   * silently stopped applying on the paths that build a row with RETURNING *
   * instead of the join. Looking it up here means no caller can forget.
   */
  private liteDepartments: Set<string> | null = null;
  private async isLite(departmentId: string): Promise<boolean> {
    if (!this.liteDepartments) {
      const rows = await query<{ department_id: string }>(
        `SELECT department_id FROM fin_departments WHERE lite`);
      this.liteDepartments = new Set(rows.map((r) => r.department_id));
    }
    return this.liteDepartments.has(departmentId);
  }

  private async view(p: Principal, row: any) {
    const label = labelFor(row.approval_state, row.payment_state);

    /* Which fields leave this API at all. Applied once, here, so every screen
       and every message is bound by it -- the legacy app checks in each
       function and three of them forget. */
    const lens = lensFor(p, {
      own: row.requester_id === p.id,
      managesDepartment: (p.managedDepartmentIds ?? []).includes(row.department_id),
      requestingDepartmentIsLite: row.department_is_lite !== undefined
        ? !!row.department_is_lite
        : await this.isLite(row.department_id),
    });

    return project({
      id: row.id,
      reference: row.reference,
      departmentId: row.department_id,
      departmentName: row.department_name ?? null,
      departmentNameAr: row.department_name_ar ?? null,
      requester: {
        id: row.requester_id,
        /* A migrated request may have no account behind it -- its author has
           left -- so the name the spreadsheet recorded stands in. Without this
           the oldest requests would show no requester at all. */
        fullName: row.requester_name ?? row.legacy_requested_by ?? null,
        formerColleague: !row.requester_id && !!row.legacy_requested_by,
      },
      type: row.type,
      description: row.description,
      moreDetails: row.more_details,
      dueDate: row.due_date instanceof Date
        ? row.due_date.toISOString().slice(0, 10) : row.due_date,
      /* Null until Purchases prices it, and it must stay null: Number(null) is
         zero, which would show a request nobody has costed yet as costing
         nothing -- and would quietly feed a zero into the cash flow. */
      requestedAmount: row.requested_amount === null ? null : Number(row.requested_amount),
      paymentMethod: row.payment_method,
      paymentDetails: row.payment_details,
      route: row.route,
      approvalState: row.approval_state,
      paymentState: row.payment_state,
      label, labelAr: LABEL_AR[label],
      waitingOn: stepOf(row.approval_state),
      rejectionReason: row.rejection_reason,
      vendorName: row.vendor_name,
      createdAt: new Date(row.created_at).toISOString(),
      canDecide: canDecide(p, this.shapeOf(row)),
      canEdit: canEditDirectly(p, this.shapeOf(row)),
      canDelete: canDelete(p, this.shapeOf(row)),
      /* Purchases has to supply the pricing when it approves, so the screen
         needs to know to ask for it. */
      needsPricing: row.approval_state === 'PURCHASES_PENDING' && !row.priced_at,
      pricedAt: row.priced_at ? new Date(row.priced_at).toISOString() : null,
      bankName: row.bank_name ?? null,
      accountNumber: row.account_number ?? null,
      beneficiaryName: row.beneficiary_name ?? null,
    }, lens);
  }

  /* ------------------------------------------------------ notifications -- */

  /**
   * Tell whoever the request is now waiting on.
   *
   * Failures are logged and swallowed. The decision is already committed and
   * is the part that mattered; a bell that did not ring is worth a log line,
   * not a rolled-back approval. The legacy app takes the same view, and it is
   * the right one.
   */
  private async tellWhoeverIsNext(row: any) {
    try {
      const step = stepOf(row.approval_state);
      if (!step) return;

      const title = `${row.reference} needs your approval`;
      /* The description, never the amount: this message goes to managers and
         to permission holders alike, and the request itself shows each of them
         whatever they are entitled to see. */
      const body = `${row.description}`.slice(0, 160);
      const link = `/finance/requests/${row.id}`;

      if (step === 'MANAGER') {
        const managers = await this.managersOf(row.department_id);
        const mail = awaitingDecisionMail({
          reference: row.reference, description: row.description,
          departmentName: row.department_name ?? '', 
          requesterName: row.requester_name ?? row.legacy_requested_by ?? 'a colleague',
          url: `${config.portalOrigin}${link}`,
        }, 'MANAGER');

        await Promise.all(managers
          .filter((id) => id !== row.requester_id)
          .map(async (id) => {
            /* A manager is one person and the whole chain stops at them, so
               this is one of the two things worth an email. */
            const notificationId = await this.notifications
              .notify(id, 'finance', title, body, 'INFO', link).catch(() => null);
            await this.alsoEmail(id, notificationId, mail);
          }));
        return;
      }
      /*
       * Finance and Purchases, by permission.
       *
       * Not notifyPermissionHolders: it sends and returns nothing, so there is
       * no notification id to hang an email on, and no link either. That left
       * the two steps where work actually queues up -- Purchases pricing and
       * Finance approving -- with a bell and no email, which is the opposite
       * of the right way round. A bell is seen by somebody already in the
       * portal; an email reaches somebody who is not.
       */
      const holders = await query<{ id: string }>(
        `SELECT DISTINCT u.id FROM core_users u
           JOIN core_user_roles ur ON ur.user_id = u.id
           JOIN core_role_permissions rp ON rp.role_id = ur.role_id
           JOIN core_permissions p ON p.id = rp.permission_id
          WHERE p.key = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
        [step === 'PURCHASES' ? PURCHASES : MANAGE]);

      const mail = awaitingDecisionMail({
        reference: row.reference, description: row.description,
        departmentName: row.department_name ?? '',
        requesterName: row.requester_name ?? row.legacy_requested_by ?? 'a colleague',
        url: `${config.portalOrigin}${link}`,
      }, step);

      await Promise.all(holders
        /* Nobody is told about their own request, at any step. */
        .filter((u) => u.id !== row.requester_id)
        .map(async (u) => {
          const notificationId = await this.notifications
            .notify(u.id, 'finance', title, body, 'INFO', link).catch(() => null);
          await this.alsoEmail(u.id, notificationId, mail);
        }));
    } catch (e: any) {
      this.log.warn(`could not notify for ${row.reference}: ${e?.message ?? e}`);
    }
  }

  /**
   * Tell the person who raised it what happened.
   *
   * No figure appears in any of these. The legacy app puts the amount in the
   * rejection email and the requested, paid and remaining figures in the
   * receipt email, which is how a department that must never see money sees
   * it -- the list was careful and the message, written somewhere else, was
   * not. The safest way not to leak a number is not to send one: the request
   * itself is one click away and shows whatever the reader may see.
   */
  private async tellTheRequester(row: any, decision: string, actor: Principal) {
    /* Only a refusal is emailed. Approved, part-paid and paid all stay in the
       bell: an inbox that fills with progress updates is one where the message
       that needed acting on gets missed. */
    try {
      const approved = decision === 'APPROVED';
      const done = row.approval_state === 'APPROVED';
      const link = `/finance/requests/${row.id}`;
      const notificationId = await this.notifications.notify(
        row.requester_id, 'finance',
        approved
          ? (done ? `${row.reference} is approved` : `${row.reference} moved forward`)
          : `${row.reference} was rejected`,
        approved
          ? (done ? 'It is now waiting to be paid.' : `Approved by ${actor.fullName}.`)
          : (row.rejection_reason ?? ''),
        approved ? 'INFO' : 'WARNING',
        link);

      /* A refusal ends the request, and the person has to do something about
         it -- raise a new one, or stop waiting. That earns an email. Moving to
         the next step does not. */
      if (!approved && row.requester_id) {
        await this.alsoEmail(row.requester_id, notificationId, refusedMail({
          reference: row.reference, description: row.description,
          departmentName: row.department_name ?? '',
          requesterName: row.requester_name ?? '',
          reason: row.rejection_reason ?? undefined,
          url: `${config.portalOrigin}${link}`,
        }));
      }
    } catch (e: any) {
      this.log.warn(`could not notify requester of ${row.reference}: ${e?.message ?? e}`);
    }
  }
}