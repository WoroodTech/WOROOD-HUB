/**
 * Queueing a request's row for the accountant's spreadsheet.
 *
 * Nothing here talks to Google. Queueing happens inside the transaction that
 * changed the request, so a row is never queued for a change that was rolled
 * back, and a change is never committed without its row being queued.
 *
 * The payload is built now rather than at send time: a retry should write what
 * was true at the moment something happened, not whatever the request has
 * become while the queue was blocked.
 */
import { Injectable, Logger } from '@nestjs/common';
import { one, query } from '../../../common/db';
import { config } from '../../../common/config';
import { SheetRequest, TAB_FOR_DEPARTMENT, toRow } from './row-mapping';

@Injectable()
export class SheetsQueueService {
  private readonly log = new Logger('SheetsQueue');

  /**
   * Queue this request's row, replacing anything already waiting for it.
   *
   * A request created, approved and paid within a minute would otherwise queue
   * three writes to one row, and they would race -- the worker could apply the
   * "approved" state after the "paid" one and leave the sheet saying a request
   * is unpaid when it is not. The partial unique index makes that impossible;
   * this replaces the waiting row instead, so exactly one write happens and it
   * carries the current truth.
   *
   * Never throws. A request must not fail to be submitted because a row could
   * not be queued for a spreadsheet.
   */
  async enqueue(requestId: string, client?: { query: Function }): Promise<void> {
    if (config.sheets.mode === 'off') return;

    try {
      const run = client
        ? (sql: string, params: any[]) => client.query(sql, params).then((r: any) => r.rows)
        : (sql: string, params: any[]) => query<any>(sql, params);

      const rows = await run(
        `SELECT r.*, f.code AS department_code, d.name AS department_name,
                u.full_name AS requester_name, u.email AS requester_email,
                COALESCE(p.paid, 0) AS paid_total, p.last_paid_at
           FROM fin_requests r
           JOIN fin_departments f ON f.department_id = r.department_id
           JOIN core_departments d ON d.id = r.department_id
           LEFT JOIN core_users u ON u.id = r.requester_id
           LEFT JOIN LATERAL (
             SELECT sum(amount) AS paid, max(paid_at) AS last_paid_at
               FROM fin_payments WHERE request_id = r.id
           ) p ON true
          WHERE r.id = $1`, [requestId]);

      const r = rows[0];
      if (!r) return;

      const tab = TAB_FOR_DEPARTMENT[r.department_code];
      if (!tab) {
        /* A department with no tab is a configuration gap, not a failure of
           this request. Logged so somebody can add the mapping; the request
           itself is unaffected. */
        this.log.warn(
          `no Log tab is mapped for department ${r.department_code}; `
          + `${r.reference} will not reach the sheet`);
        return;
      }

      const payload = await this.buildRow(r, tab, run);

      /*
       * One waiting event per request, carrying the newest state.
       *
       * The index this conflicts against covers FAILED as well as PENDING and
       * SENDING, and that is the point: a failed event is still an event
       * waiting to happen. Covering only the first two let a new event be
       * inserted beside a failed one, and the older of the two could be
       * retried last and undo the newer state.
       *
       * Done as ON CONFLICT rather than as an UPDATE followed by an INSERT:
       * a CTE and the statement around it see the same snapshot, so retiring
       * the old row in a CTE leaves the index still seeing it and the insert
       * fails. WRITTEN and DEAD are outside the index and are left alone —
       * they are finished, and what reached the sheet is worth keeping.
       */
      await run(
        `INSERT INTO fin_sheet_events (request_id, payload, tab)
         VALUES ($1, $2, $3)
         ON CONFLICT (request_id)
           WHERE status IN ('PENDING', 'SENDING', 'FAILED')
         DO UPDATE SET
           payload = EXCLUDED.payload,
           tab = EXCLUDED.tab,
           /* Back to the front: the newer state is the one worth writing,
              and an event that had been backing off keeps no penalty. */
           status = 'PENDING',
           attempts = 0,
           next_attempt_at = now(),
           last_attempt_at = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           error = NULL`,
        [requestId, JSON.stringify(payload), tab]);
    } catch (e: any) {
      this.log.warn(`could not queue ${requestId} for the sheet: ${e?.message ?? e}`);
    }
  }

  /** The row, in the shape the mapping expects. */
  private async buildRow(r: any, tab: string, run: Function) {
    const files = await run(
      `SELECT original_name, kind FROM fin_request_files
        WHERE request_id = $1 AND status = 'READY' ORDER BY created_at`, [r.id])
      .catch(() => []);

    const named = (kind: string) => (files as any[])
      .filter((f) => f.kind === kind)
      .map((f) => f.original_name)
      .filter(Boolean);

    /* The approval trail, in the shape the sheet already holds: a name and a
       time, or the route when nobody decided it personally. */
    const approvedByRoute = r.route === 'finance' && !r.manager_decided_at
      ? 'Direct to Accounts'
      : (r.finance_decided_at || r.manager_decided_at ? await this.trail(r, run) : '');

    const request: SheetRequest = {
      reference: r.reference,
      dueDate: r.due_date ? new Date(r.due_date).toISOString() : null,
      type: r.type,
      description: r.description,
      requestedAmount: r.requested_amount === null ? null : Number(r.requested_amount),
      requesterName: r.requester_name ?? r.legacy_requested_by ?? null,
      /* The login, as the sheet records it: the part of the address before
         the @, which is what the old app wrote. */
      requesterLogin: r.requester_email ? String(r.requester_email).split('@')[0] : null,
      paidTotal: Number(r.paid_total ?? 0),
      lastPaymentDate: r.last_paid_at ? new Date(r.last_paid_at).toISOString() : null,
      statusLabel: this.statusLabel(r),
      createdAt: new Date(r.created_at).toISOString(),
      paymentMethod: r.payment_method,
      paymentDetails: r.payment_details,
      moreDetails: r.more_details,
      fileNames: named('ATTACHMENT'),
      receiptNames: named('RECEIPT'),
      approvedByRoute,
      vendorName: r.vendor_name,
      /* Which department it really came from. Only meaningful on Purchases
         Log, where the three lite departments are logged. */
      source: tab === 'Purchases Log' ? r.department_name : null,
    };

    return { request, row: toRow(request, tab), tab };
  }

  /**
   * Who approved it last, and when.
   *
   * The column is `created_at`, not `at`. It was `at` here, which is not a
   * column, so the query threw, the catch swallowed it, and column R came out
   * empty on every single row -- a value silently missing rather than a
   * failure anybody would see. The dry run is what caught it.
   *
   * The catch stays, because a missing approval trail must not stop a row
   * reaching the sheet. It now logs, so the next time something like this
   * happens it says so instead of disappearing.
   */
  private async trail(r: any, run: Function): Promise<string> {
    const rows = await run(
      `SELECT u.full_name, a.created_at FROM fin_request_approvals a
         JOIN core_users u ON u.id = a.decided_by_id
        WHERE a.request_id = $1 AND a.decision = 'APPROVED'
        ORDER BY a.created_at DESC LIMIT 1`, [r.id])
      .catch((e: any) => {
        this.log.warn(`could not read the approval trail for ${r.reference}: ${e?.message ?? e}`);
        return [];
      });
    const last = (rows as any[])[0];
    if (!last) return '';
    const d = new Date(last.created_at);
    const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'Africa/Cairo' });
    const day = d.toLocaleString('en-GB', { day: '2-digit', timeZone: 'Africa/Cairo' });
    const time = d.toLocaleString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Cairo' });
    return `${last.full_name} - ${day}-${month} ${time}`;
  }

  /** The words the sheet uses, which are not the portal's state names. */
  private statusLabel(r: any): string {
    if (r.deleted_at) return 'Deleted';
    if (r.approval_state === 'REJECTED') return 'Rejected';
    if (r.approval_state !== 'APPROVED') return 'Pending';
    if (r.payment_state === 'PAID') return 'Complete';
    if (r.payment_state === 'PARTIAL') return 'Partial Pay';
    return 'In Progress';
  }
}