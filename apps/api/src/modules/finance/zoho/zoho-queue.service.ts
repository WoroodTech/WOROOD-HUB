/**
 * Getting payments into Zoho Books, eventually and exactly once.
 *
 * The legacy app posts inline when a payment is recorded. If Zoho is slow the
 * person waits; if it refuses, the payment is already in the sheet and the
 * failure is a line in a hidden log tab. The handover lists this as a known
 * limitation and it is the one that matters most: a payment missing from the
 * accounts is invisible until somebody reconciles by hand.
 *
 * So the intention to post is a row, and a worker drains it. The shape is the
 * one already running in production for Shopify webhooks -- claim under
 * `FOR UPDATE SKIP LOCKED`, hold a lease, retry with backoff, dead-letter when
 * out of attempts -- because it works and because an operator who has learned
 * one of these has learned both.
 *
 * The hard case is not failure. It is *uncertainty*: the call timed out and
 * Zoho may or may not have created the record. Every retry therefore asks Zoho
 * whether something with our reference already exists before creating
 * anything, and adopts it if so.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Principal } from '../../../common/auth';
import { one, query, tx } from '../../../common/db';
import { config } from '../../../common/config';
import { ZohoBooksClient, ZohoError } from './books-client';

/** Six goes over about a day, which is long enough to ride out an outage. */
const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 20, 60, 240, 720];

/** How long a worker holds a claim before it is considered dead. */
const LEASE_SECONDS = 120;

export type ZohoKind = 'EXPENSE' | 'VENDOR_PAYMENT' | 'CUSTODY_TRANSFER';

@Injectable()
export class ZohoQueueService {
  private readonly log = new Logger('ZohoQueue');

  constructor(private readonly books: ZohoBooksClient) {}

  /**
   * Queue a payment for posting.
   *
   * Called after the payment is committed, never inside its transaction: the
   * payment is a fact about our own records and must not be held up, or undone,
   * by anything to do with Zoho.
   *
   * The body is built now rather than when it is sent, so what reaches the
   * accounts is what was true when the money moved -- not whatever the request
   * has become by the time the queue drains.
   */
  async enqueuePayment(paymentId: string): Promise<void> {
    const pm = await one<any>(
      `SELECT pm.*, r.reference, r.description, r.type, r.vendor_name,
              r.payment_method, r.payment_details, r.requested_amount,
              d.name AS department_name
         FROM fin_payments pm
         JOIN fin_requests r ON r.id = pm.request_id
         JOIN core_departments d ON d.id = r.department_id
        WHERE pm.id = $1`, [paymentId]);
    if (!pm) return;

    /* A reversal is not posted. Undoing an entry in somebody's accounts is a
       bookkeeping decision, and guessing at one from here would be worse than
       leaving Finance to make it. */
    if (pm.reversal_of_id) {
      this.log.log(`payment ${paymentId} is a reversal; not posting to Zoho`);
      return;
    }

    const kind = this.kindFor(pm);
    /* A vendor payment with no purchase order posts nothing in the legacy app
       either -- there is no bill to apply it to. Recorded as SKIPPED rather
       than silently dropped, so the gap is visible in the queue. */
    const skipped = kind === 'VENDOR_PAYMENT' && !pm.vendor_name;
    const missing = skipped ? null : this.missingAccounts(kind, pm);

    await query(
      `INSERT INTO fin_zoho_events
         (kind, request_id, payment_id, payload, idempotency_key, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [kind, pm.request_id, paymentId, JSON.stringify(this.bodyFor(kind, pm)),
       /* Derived from our own payment id, so a retry sends an identical
          reference and Zoho can be asked whether it already has one. */
       `payment:${paymentId}`,
       skipped ? 'SKIPPED' : missing ? 'DEAD' : 'PENDING',
       missing ? `Cannot be posted: ${missing}.` : null]);

    if (missing) {
      this.log.warn(`payment ${paymentId} cannot be posted to Zoho: ${missing}`);
    }
  }

  private kindFor(pm: any): ZohoKind {
    if (pm.type === 'Petty Cash') return 'CUSTODY_TRANSFER';
    if (pm.type === 'Vendors Payments') return 'VENDOR_PAYMENT';
    return 'EXPENSE';
  }

  /**
   * The body Zoho receives, by kind.
   *
   * The accounts come from the payment, not from configuration. The legacy
   * integration resolves them at runtime -- the expense account is chosen per
   * request from the whole expense chart, and the custody target is one of
   * about fifteen accounts under "Petty Cash" -- so a single configured
   * account would post every department's spending to one line.
   *
   * A branch is sent only if one was chosen. The legacy payload sends none and
   * Zoho assigns its default, which is why existing records carry a branch
   * nobody set deliberately.
   */
  private bodyFor(kind: ZohoKind, pm: any): Record<string, unknown> {
    const amount = Number(pm.amount);
    const date = new Date(pm.paid_at).toISOString().slice(0, 10);
    const reference = pm.reference;
    const description = `${reference} — ${pm.description}`.slice(0, 500);
    const branch = pm.zoho_branch_id ? { branch_id: pm.zoho_branch_id } : {};

    if (kind === 'CUSTODY_TRANSFER') {
      return {
        transaction_type: 'transfer_fund',
        amount, date,
        from_account_id: pm.zoho_paid_through_account_id,
        to_account_id: pm.zoho_to_account_id,
        /* Bank transactions take no attachment in Zoho, so a receipt can only
           be referred to in words. The legacy app does the same. */
        description,
        reference_number: reference,
        ...branch,
      };
    }
    if (kind === 'VENDOR_PAYMENT') {
      return {
        /* Applied to no bill: an advance against the purchase order, which is
           what the legacy app does. */
        amount, date,
        reference_number: reference,
        description,
        vendor_name: pm.vendor_name,
        paid_through_account_id: pm.zoho_paid_through_account_id,
        ...branch,
      };
    }
    return {
      amount, date,
      account_id: pm.zoho_expense_account_id,
      paid_through_account_id: pm.zoho_paid_through_account_id,
      reference_number: reference,
      description,
      ...branch,
    };
  }

  /**
   * Is this payment postable at all?
   *
   * Checked when queueing rather than when posting: an event that can never
   * succeed should be visible as such immediately, not after six attempts
   * across a day.
   */
  private missingAccounts(kind: ZohoKind, pm: any): string | null {
    if (!pm.zoho_paid_through_account_id) return 'no account was chosen to pay from';
    if (kind === 'CUSTODY_TRANSFER' && !pm.zoho_to_account_id) {
      return 'no custody account was chosen to move the money into';
    }
    if (kind === 'EXPENSE' && !pm.zoho_expense_account_id) {
      return 'no expense account was chosen';
    }
    return null;
  }

  private pathFor(kind: ZohoKind): string {
    return kind === 'CUSTODY_TRANSFER' ? '/banktransactions'
         : kind === 'VENDOR_PAYMENT' ? '/vendorpayments'
         : '/expenses';
  }

  /**
   * Take one event and post it.
   *
   * Returns false when there was nothing to do, so the worker can sleep rather
   * than spin.
   */
  async drainOne(owner: string): Promise<boolean> {
    const claimed = await tx(async (c) => {
      /* SKIP LOCKED is what lets several workers drain the same queue without
         coordinating: each takes a row nobody else holds. */
      const { rows } = await c.query(
        `SELECT * FROM fin_zoho_events
          WHERE status IN ('PENDING', 'FAILED')
            AND next_attempt_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY next_attempt_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`);
      const row = rows[0];
      if (!row) return null;

      const { rows: out } = await c.query(
        `UPDATE fin_zoho_events
            SET status='PROCESSING', attempts = attempts + 1, last_attempt_at = now(),
                lease_owner = $2, lease_expires_at = now() + ($3 || ' seconds')::interval
          WHERE id = $1 RETURNING *`,
        [row.id, owner, LEASE_SECONDS]);
      return out[0];
    });

    if (!claimed) return false;

    try {
      const kind = claimed.kind as ZohoKind;
      const path = this.pathFor(kind);
      const payload = claimed.payload ?? {};
      const reference = String(payload.reference_number ?? '');

      /* The step that makes an uncertain outcome survivable. If a previous
         attempt timed out after Zoho had already created the record, this
         finds it and adopts it instead of creating a second. */
      let recordId = reference
        ? await this.books.findByReference(path.slice(1), reference)
        : null;

      if (recordId) {
        this.log.warn(
          `${reference} was already in Zoho; adopting ${recordId} rather than posting again`);
      } else {
        const out = await this.books.call('POST', path, { body: payload });
        recordId = out?.expense_id ?? out?.vendor_payment_id
          ?? out?.transaction_id ?? out?.id ?? null;
        if (!recordId) {
          throw new ZohoError(502, 'Zoho accepted the record but returned no id', undefined, true);
        }
      }

      await query(
        `UPDATE fin_zoho_events
            SET status='POSTED', zoho_record_id=$2, zoho_reference=$3,
                posted_at=now(), error=NULL, lease_owner=NULL, lease_expires_at=NULL
          WHERE id=$1`, [claimed.id, String(recordId), reference || null]);

      this.log.log(`posted ${reference} to Zoho as ${recordId}`);
      return true;
    } catch (e: any) {
      await this.recordFailure(claimed, e);
      return true;
    }
  }

  /**
   * A failed attempt.
   *
   * A body Zoho will never accept is dead immediately: retrying a 400 six
   * times wastes a day and ends in the same place, and the sooner it is on
   * somebody's screen the better. Everything else backs off.
   */
  private async recordFailure(row: any, e: any) {
    const retryable = e instanceof ZohoError ? e.retryable : true;
    const attempts = Number(row.attempts);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const dead = !retryable || exhausted;

    const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
    await query(
      `UPDATE fin_zoho_events
          SET status = $2, error = $3,
              next_attempt_at = now() + ($4 || ' minutes')::interval,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [row.id, dead ? 'DEAD' : 'FAILED', String(e?.message ?? e).slice(0, 2000), minutes]);

    if (dead) {
      this.log.error(
        `${row.idempotency_key} will not be posted: ${e?.message ?? e}`
        + (retryable ? ` (gave up after ${attempts} attempts)` : ' (Zoho refused it outright)'));
    } else {
      this.log.warn(
        `${row.idempotency_key} failed, attempt ${attempts}, retrying in ${minutes}m: `
        + `${e?.message ?? e}`);
    }
  }

  /**
   * Release anything this worker was holding when it stopped.
   *
   * Called at startup. Without it, a crash leaves rows PROCESSING until their
   * leases expire, which delays everything the worker was mid-way through for
   * no reason -- it is back, and it knows those were its own.
   */
  async reclaimOwn(owner: string): Promise<number> {
    const out = await query<{ id: string }>(
      `UPDATE fin_zoho_events
          SET status='FAILED', lease_owner=NULL, lease_expires_at=NULL,
              next_attempt_at=now()
        WHERE status='PROCESSING' AND lease_owner=$1 RETURNING id`, [owner]);
    if (out.length) this.log.log(`reclaimed ${out.length} event(s) left over from a restart`);
    return out.length;
  }

  /** What an operator needs to see: what is stuck, and why. */
  async health() {
    const rows = await query<any>(
      `SELECT status, count(*) AS n FROM fin_zoho_events GROUP BY status`);
    const by: Record<string, number> = {};
    for (const r of rows) by[r.status] = Number(r.n);

    const stuck = await query<any>(
      `SELECT e.id, e.kind, e.idempotency_key, e.attempts, e.error, e.created_at,
              r.reference
         FROM fin_zoho_events e
         LEFT JOIN fin_requests r ON r.id = e.request_id
        WHERE e.status = 'DEAD'
        ORDER BY e.created_at DESC LIMIT 50`);

    return {
      mode: this.books.mode,
      configured: this.books.configured,
      counts: by,
      dead: stuck.map((s) => ({
        id: s.id, kind: s.kind, reference: s.reference,
        attempts: Number(s.attempts), error: s.error,
        at: new Date(s.created_at).toISOString(),
      })),
    };
  }

  /** Put a dead event back in the queue, once somebody has fixed the cause. */
  async retry(p: Principal, eventId: string) {
    const row = await one<any>(
      `UPDATE fin_zoho_events
          SET status='PENDING', next_attempt_at=now(), attempts=0, error=NULL
        WHERE id=$1 AND status='DEAD' RETURNING id, idempotency_key`, [eventId]);
    if (!row) return { retried: false };
    this.log.log(`${p.fullName} put ${row.idempotency_key} back in the queue`);
    return { retried: true };
  }
}