/**
 * Asking to change a request that has already been approved.
 *
 * While a request is Open its author edits it in place -- nobody has agreed to
 * anything. Once Finance has approved it, the amount is something several
 * people signed off, and changing it is a new decision for each of them. So it
 * goes back round: department manager, then Finance, and only when both agree
 * does the request itself change.
 *
 * The thing to hold on to: **the edit carries the new values, the request keeps
 * the old ones, and nothing moves between them until the chain completes.** An
 * edit approved by the manager alone changes nothing. This is the part the
 * legacy app got wrong -- it had two code paths that could write a new amount,
 * with different rules about what was allowed, so which rule applied depended
 * on which button somebody pressed.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Principal, can } from '../../common/auth';
import { one, query, tx } from '../../common/db';
import { AuditService, NotificationsService } from '../../core/core.module';

const MANAGE = 'finance.request.manage';
const REPORT = 'finance.report.view';
const PURCHASES = 'finance.purchases.decide';

export interface EditInput {
  newAmount?: number;
  newDescription?: string;
  newMoreDetails?: string;
  newDueDate?: string;
  newPaymentMethod?: string;
  newAccountNumber?: string;
  newBankName?: string;
  newBeneficiaryName?: string;
  reason: string;
}

@Injectable()
export class FinanceEditsService {
  private readonly log = new Logger('FinanceEdits');

  constructor(
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ask for a change.
   *
   * Only the person who raised the request, and only once it has been
   * approved: while it is still Open there is nothing to ask permission for,
   * and the direct edit is the right route.
   */
  async request(p: Principal, requestId: string, dto: EditInput) {
    const r = await one<any>(
      `SELECT * FROM fin_requests WHERE id=$1 AND deleted_at IS NULL`, [requestId]);
    if (!r) throw new NotFoundException('No such request.');

    if (r.requester_id !== p.id) {
      throw new ForbiddenException('Only the person who raised it can ask for a change.');
    }
    if (r.approval_state !== 'APPROVED') {
      throw new BadRequestException(
        r.approval_state === 'REJECTED'
          ? 'This request was rejected. Raise a new one.'
          : 'This request has not been approved yet, so you can still change it directly.');
    }

    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why the change is needed.');

    const amount = dto.newAmount === undefined ? null : Number(dto.newAmount);
    if (amount !== null && !(amount > 0)) {
      throw new BadRequestException('The new amount must be more than zero.');
    }

    /* Nothing may be reduced below what has already gone out. In phase 1 no
       payment can exist yet, so this is a guard that becomes load-bearing the
       moment the payments ledger arrives -- written now, in the one place an
       amount can change, rather than retrofitted into several later. */
    if (amount !== null) {
      const paid = await this.paidSoFar(requestId);
      if (paid > 0 && amount < paid) {
        throw new BadRequestException(
          `${paid.toFixed(2)} has already been paid against this request, `
          + 'so it cannot be reduced below that.');
      }
    }

    const asksForSomething = amount !== null
      || dto.newDescription !== undefined || dto.newMoreDetails !== undefined
      || dto.newDueDate !== undefined || dto.newPaymentMethod !== undefined
      || dto.newAccountNumber !== undefined;
    if (!asksForSomething) {
      throw new BadRequestException('Say what you would like to change.');
    }

    const managerIds = await this.managersOf(r.department_id);
    /* Same shape as the request's own chain: a manager asking to change his own
       request skips his own step, because nobody approves their own. */
    const skipsManager = managerIds.length === 0 || managerIds.includes(p.id);
    const status = skipsManager ? 'FINANCE_PENDING' : 'MANAGER_PENDING';

    let row;
    try {
      row = await one<any>(
        `INSERT INTO fin_request_edits
           (request_id, requested_by_id, new_amount, new_description, new_more_details,
            new_due_date, new_payment_method, new_account_number, new_bank_name,
            new_beneficiary_name, reason, amount_before, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [requestId, p.id, amount, dto.newDescription ?? null, dto.newMoreDetails ?? null,
         dto.newDueDate ?? null, dto.newPaymentMethod ?? null, dto.newAccountNumber ?? null,
         dto.newBankName ?? null, dto.newBeneficiaryName ?? null,
         reason, r.requested_amount, status]);
    } catch (e: any) {
      /* The partial unique index: one open edit per request. Two people asking
         for different amounts and both being approved would leave the request
         holding whichever landed last. */
      if (e?.code === '23505') {
        throw new BadRequestException(
          'There is already a change waiting to be decided on this request.');
      }
      throw e;
    }

    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: 'edit.request',
      entityType: 'fin_request_edit', entityId: row.id,
      payload: { reference: r.reference, newAmount: amount, status },
    });

    /* The reason goes on the request's own conversation as well, so somebody
       reading the request sees why a change was asked for without opening the
       edit. */
    await query(
      `INSERT INTO fin_request_notes (request_id, author_id, body) VALUES ($1,$2,$3)`,
      [requestId, p.id, reason]);

    await this.tellWhoeverIsNext(r, row);
    return this.view(p, { ...row, reference: r.reference });
  }

  /**
   * Approve or reject a change, at whichever step it is waiting on.
   *
   * Approving at the manager step moves it to Finance and changes nothing.
   * Approving at the Finance step applies it to the request, in the same
   * transaction, so the request cannot be left holding an agreed change that
   * was never written.
   */
  async decide(p: Principal, editId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT e.*, r.department_id, r.reference, r.requester_id AS request_requester_id
           FROM fin_request_edits e
           JOIN fin_requests r ON r.id = e.request_id
          WHERE e.id = $1 FOR UPDATE OF e`, [editId]);
      const e = rows[0];
      if (!e) throw new NotFoundException('No such change.');

      const step = e.status === 'MANAGER_PENDING' ? 'MANAGER'
                 : e.status === 'FINANCE_PENDING' ? 'FINANCE' : null;
      if (!step) throw new BadRequestException('This change has already been decided.');

      // Nobody decides their own, at any step.
      if (e.requested_by_id === p.id) {
        throw new ForbiddenException('You cannot decide your own change.');
      }
      const allowed = step === 'MANAGER'
        ? (p.managedDepartmentIds ?? []).includes(e.department_id)
        : can(p, MANAGE);
      if (!allowed) throw new ForbiddenException('This change is not waiting for you.');

      if (decision === 'REJECTED' && !reason?.trim()) {
        throw new BadRequestException('Say why the change is being refused.');
      }

      const column = step === 'MANAGER' ? 'manager' : 'finance';
      const status = decision === 'REJECTED' ? 'REJECTED'
                   : step === 'MANAGER' ? 'FINANCE_PENDING' : 'APPLIED';

      const { rows: out } = await c.query(
        `UPDATE fin_request_edits SET
           status = $2,
           ${column}_decided_by_id = $3,
           ${column}_decided_at = now(),
           decision_reason = COALESCE($4, decision_reason),
           applied_at = CASE WHEN $2 = 'APPLIED' THEN now() ELSE applied_at END
         WHERE id = $1 RETURNING *`,
        [editId, status, p.id, reason ?? null]);

      /* Only here, at the end of the chain, does the request change. In the
         same transaction as the decision, so the two cannot disagree. */
      if (status === 'APPLIED') {
        await c.query(
          `UPDATE fin_requests SET
             requested_amount = COALESCE($2, requested_amount),
             description      = COALESCE($3, description),
             more_details     = COALESCE($4, more_details),
             due_date         = COALESCE($5, due_date),
             payment_method   = COALESCE($6, payment_method),
             account_number   = COALESCE($7, account_number),
             bank_name        = COALESCE($8, bank_name),
             beneficiary_name = COALESCE($9, beneficiary_name)
           WHERE id = $1`,
          [e.request_id, e.new_amount, e.new_description, e.new_more_details,
           e.new_due_date, e.new_payment_method, e.new_account_number,
           e.new_bank_name, e.new_beneficiary_name]);

        /* The approval trail of the request records that its figure moved and
           who agreed to it, so reading the request alone tells the story. */
        await c.query(
          `INSERT INTO fin_request_approvals
             (request_id, step, decision, decided_by_id, reason, amount_at_decision)
           VALUES ($1,'FINANCE','APPROVED',$2,$3,$4)`,
          [e.request_id, p.id,
           `Change applied: ${e.reason}`.slice(0, 1000),
           e.new_amount ?? e.amount_before]);
      }

      return { ...out[0], reference: e.reference, department_id: e.department_id };
    });

    await this.audit.write({
      actorId: p.id, moduleKey: 'finance', action: `edit.${decision.toLowerCase()}`,
      entityType: 'fin_request_edit', entityId: editId,
      payload: { reference: result.reference, status: result.status },
    });

    await this.tellTheRequester(result);
    if (result.status === 'FINANCE_PENDING') {
      await this.tellWhoeverIsNext({ department_id: result.department_id,
                                     reference: result.reference }, result);
    }
    return this.view(p, result);
  }

  /** Take back a change nobody has decided yet. */
  async withdraw(p: Principal, editId: string) {
    const e = await one<any>(`SELECT * FROM fin_request_edits WHERE id=$1`, [editId]);
    if (!e) throw new NotFoundException('No such change.');
    if (e.requested_by_id !== p.id) {
      throw new ForbiddenException('Only the person who asked for it can take it back.');
    }
    if (e.status !== 'MANAGER_PENDING' && e.status !== 'FINANCE_PENDING') {
      throw new BadRequestException('This change has already been decided.');
    }
    await query(`UPDATE fin_request_edits SET status='WITHDRAWN' WHERE id=$1`, [editId]);
    return { withdrawn: true };
  }

  /** Every change asked for on one request, newest first. */
  async forRequest(p: Principal, requestId: string) {
    /* The request's department has to come back with the edit: `view` decides
       whether this person may act on it by asking whether they manage that
       department, and without the column the answer was always no -- so a
       manager saw the change and no way to agree to it. */
    const rows = await query<any>(
      `SELECT e.*, u.full_name AS requested_by_name,
              r.department_id, r.reference
         FROM fin_request_edits e
         JOIN fin_requests r ON r.id = e.request_id
         JOIN core_users u ON u.id = e.requested_by_id
        WHERE e.request_id = $1 ORDER BY e.created_at DESC`, [requestId]);
    return rows.map((e) => this.view(p, e));
  }

  /** Changes waiting on this person, for the approvals queue. */
  async queue(p: Principal) {
    const clauses: string[] = [];
    const params: any[] = [p.id];
    const managed = p.managedDepartmentIds ?? [];

    if (managed.length) {
      params.push(managed);
      clauses.push(`(e.status = 'MANAGER_PENDING'
                     AND r.department_id = ANY($${params.length}::uuid[]))`);
    }
    if (can(p, MANAGE)) clauses.push(`e.status = 'FINANCE_PENDING'`);
    if (!clauses.length) return [];

    const rows = await query<any>(
      `SELECT e.*, r.reference, r.description AS request_description,
              r.department_id,
              u.full_name AS requested_by_name
         FROM fin_request_edits e
         JOIN fin_requests r ON r.id = e.request_id
         JOIN core_users u ON u.id = e.requested_by_id
        WHERE r.deleted_at IS NULL
          AND (${clauses.join(' OR ')})
          AND e.requested_by_id <> $1
        ORDER BY e.created_at`, params);
    return rows.map((e) => this.view(p, e));
  }

  /* ------------------------------------------------------------ helpers -- */

  /**
   * How much has gone out against this request.
   *
   * A sum of the ledger, never a stored figure. The rule above it -- an amount
   * may never be reduced below what has already been paid -- was written when
   * there were no payments to read, and now that there are it simply started
   * working. That is the whole reason it went in early.
   */
  private async paidSoFar(requestId: string): Promise<number> {
    const row = await one<any>(
      `SELECT COALESCE(sum(amount), 0) AS paid FROM fin_payments WHERE request_id=$1`,
      [requestId]);
    return Number(row?.paid ?? 0);
  }

  private async managersOf(departmentId: string): Promise<string[]> {
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM core_department_managers WHERE department_id = $1`,
      [departmentId]);
    return rows.map((r) => r.user_id);
  }

  private view(p: Principal, e: any) {
    const step = e.status === 'MANAGER_PENDING' ? 'MANAGER'
               : e.status === 'FINANCE_PENDING' ? 'FINANCE' : null;
    const canDecide = !!step && e.requested_by_id !== p.id
      && (step === 'MANAGER'
        ? (p.managedDepartmentIds ?? []).includes(e.department_id)
        : can(p, MANAGE));

    return {
      id: e.id,
      requestId: e.request_id,
      reference: e.reference ?? null,
      requestedBy: { id: e.requested_by_id, fullName: e.requested_by_name ?? null },
      newAmount: e.new_amount === null || e.new_amount === undefined
        ? null : Number(e.new_amount),
      amountBefore: e.amount_before === null || e.amount_before === undefined
        ? null : Number(e.amount_before),
      newDescription: e.new_description ?? null,
      newMoreDetails: e.new_more_details ?? null,
      newDueDate: e.new_due_date instanceof Date
        ? e.new_due_date.toISOString().slice(0, 10) : (e.new_due_date ?? null),
      newPaymentMethod: e.new_payment_method ?? null,
      newAccountNumber: e.new_account_number ?? null,
      newBankName: e.new_bank_name ?? null,
      newBeneficiaryName: e.new_beneficiary_name ?? null,
      reason: e.reason,
      status: e.status,
      waitingOn: step,
      decisionReason: e.decision_reason ?? null,
      createdAt: new Date(e.created_at).toISOString(),
      appliedAt: e.applied_at ? new Date(e.applied_at).toISOString() : null,
      canDecide,
      canWithdraw: !!step && e.requested_by_id === p.id,
    };
  }

  /* Notifications never fail a decision: the decision is committed and is the
     part that mattered. */
  private async tellWhoeverIsNext(r: any, e: any) {
    try {
      const title = `${r.reference}: a change needs your approval`;
      /* The reason, never the figure. This message goes to managers and to
         permission holders, and some of its readers belong to departments that
         must never see an amount -- the legacy app leaks exactly here, in a
         message assembled far from the list that was careful. Whoever opens
         the request sees whatever they are entitled to. */
      const body = String(e.reason).slice(0, 160);

      if (e.status === 'MANAGER_PENDING') {
        const managers = await this.managersOf(r.department_id);
        await Promise.all(managers
          .filter((id) => id !== e.requested_by_id)
          .map((id) => this.notifications
            .notify(id, 'finance', title, body, 'INFO', `/finance/requests/${e.request_id}`)
            .catch(() => undefined)));
        return;
      }
      await this.notifications.notifyPermissionHolders(
        MANAGE, 'finance', title, `${body}  (/finance/requests/${e.request_id})`, 'INFO');
    } catch (err: any) {
      this.log.warn(`could not notify about edit ${e.id}: ${err?.message ?? err}`);
    }
  }

  private async tellTheRequester(e: any) {
    try {
      const done = e.status === 'APPLIED';
      const refused = e.status === 'REJECTED';
      await this.notifications.notify(
        e.requested_by_id, 'finance',
        done ? `${e.reference}: your change was applied`
        : refused ? `${e.reference}: your change was refused`
        : `${e.reference}: your change moved forward`,
        refused ? (e.decision_reason ?? '') : '',
        refused ? 'WARNING' : 'INFO',
        `/finance/requests/${e.request_id}`);
    } catch (err: any) {
      this.log.warn(`could not notify requester about edit ${e.id}: ${err?.message ?? err}`);
    }
  }
}