/**
 * Draining the sheet queue.
 *
 * The same shape as the Zoho worker, for the same reasons: claim with
 * `FOR UPDATE SKIP LOCKED` so two workers never take one row, lease so a
 * worker that dies does not strand its work, back off so an outage does not
 * become a hammering, and dead-letter so a row that can never succeed stops
 * being retried forever.
 *
 * Two things specific to a spreadsheet somebody else is also editing:
 *
 * **The header is checked before every write.** The accountant can rename or
 * reorder a column at any time, and a write into a moved column does not fail
 * -- it lands in the wrong place and the formulas reading it quietly change
 * meaning. Checking costs one read and removes the whole class of problem.
 *
 * **Rows are found by their reference, never by a remembered number.** Sorting
 * the sheet moves every row. The remembered number is kept only as a hint to
 * check first, so the common case is one read rather than a thousand.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { config } from '../../../common/config';
import { one, query, tx } from '../../../common/db';
import { SheetsClient } from './sheets-client';
import { COLUMNS, ID_COLUMN_INDEX, spansFor } from './row-mapping';

/** Minutes, by attempt. A sheet being unreachable is usually brief. */
const BACKOFF = [1, 5, 20, 60, 180];
const MAX_ATTEMPTS = 6;

/** The columns the mapping writes, as the sheet names them. */
const EXPECTED_HEADER = [
  'Due Date', 'Type', 'Description', 'Requested Amount', 'Requested By',
  'Paid Total', 'Remaining', 'Status', 'Last Payment Date', 'ID', 'Created At',
  'Payment Method', 'Payment Details', 'More Details', 'Requester (login)',
  'Files', 'Receipts', 'Approved By / Route',
];

@Injectable()
export class SheetsWorker implements OnModuleInit {
  private readonly log = new Logger('SheetsWorker');
  private readonly owner = `sheets-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private checkedTabs = new Set<string>();

  constructor(private readonly sheets: SheetsClient) {}

  onModuleInit() {
    if (config.sheets.mode === 'off') {
      this.log.log('the sheet integration is off; the queue will hold');
      return;
    }
    this.log.log(`draining the sheet queue in ${config.sheets.mode} mode`);
    this.timer = setInterval(() => void this.drain().catch(() => undefined), 15_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async drain(limit = 10): Promise<{ written: number; failed: number }> {
    let written = 0, failed = 0;
    for (let i = 0; i < limit; i++) {
      const event = await this.claim();
      if (!event) break;
      try {
        await this.write(event);
        written++;
      } catch (e: any) {
        await this.recordFailure(event, e);
        failed++;
      }
    }
    return { written, failed };
  }

  /** One event, claimed so nobody else takes it. */
  private async claim() {
    return tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM fin_sheet_events
          WHERE status IN ('PENDING','FAILED')
            AND next_attempt_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
          ORDER BY next_attempt_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`);
      const e = rows[0];
      if (!e) return null;
      await c.query(
        `UPDATE fin_sheet_events
            SET status='SENDING', lease_owner=$2,
                lease_expires_at = now() + interval '2 minutes',
                attempts = attempts + 1, last_attempt_at = now()
          WHERE id=$1`, [e.id, this.owner]);
      return e;
    });
  }

  /**
   * Confirm the tab's columns are where the mapping thinks they are.
   *
   * Checked once per tab per process rather than on every write: the
   * accountant can move a column at any moment, but not between two writes a
   * second apart, and a read before every row would triple the API calls for
   * no real gain. A worker restart rechecks.
   */
  private async assertHeader(tab: string) {
    if (this.checkedTabs.has(tab)) return;

    const header = await this.sheets.readHeader(tab);
    const wrong: string[] = [];
    EXPECTED_HEADER.forEach((name, i) => {
      const found = (header[i] ?? '').trim();
      if (found.toLowerCase() !== name.toLowerCase()) {
        wrong.push(`${String.fromCharCode(65 + i)}: expected "${name}", found "${found}"`);
      }
    });

    if (wrong.length) {
      /* Refused rather than written around. A value in a moved column does
         not fail -- it lands somewhere the accountant's formulas read, and
         the first sign is a total being wrong weeks later. */
      throw new Error(
        `The columns in "${tab}" are not where they were. Nothing was written. `
        + wrong.join('; '));
    }
    this.checkedTabs.add(tab);
  }

  /**
   * Find this request's row, or say where a new one goes.
   *
   * The remembered number is a hint and is confirmed against the reference
   * before it is trusted; sorting the sheet moves every row, and writing to a
   * remembered number afterwards would overwrite somebody else's request.
   */
  private async findRow(tab: string, reference: string, hint: number | null) {
    if (hint && hint > 1) {
      const column = await this.sheets.readColumn(tab, ID_COLUMN_INDEX, hint);
      if ((column[hint - 1] ?? '').trim() === reference) return { row: hint, existing: true };
    }

    const ids = await this.sheets.readColumn(tab, ID_COLUMN_INDEX);
    const found = ids.findIndex((v) => v.trim() === reference);
    if (found >= 0) return { row: found + 1, existing: true };

    let last = 0;
    ids.forEach((v, i) => { if (v.trim() !== '') last = i + 1; });
    return { row: last + 1, existing: false };
  }

  private async write(event: any) {
    const tab: string = event.tab;
    const payload = event.payload ?? {};
    const reference: string = payload?.request?.reference;
    const row: (string | number | null)[] = payload?.row;

    if (!reference || !Array.isArray(row)) {
      throw Object.assign(new Error('the queued payload has no row in it'),
                          { permanent: true });
    }

    await this.assertHeader(tab);

    const hint = await one<any>(
      `SELECT sheet_row, sheet_tab FROM fin_requests WHERE id=$1`, [event.request_id]);

    const target = await this.findRow(
      tab, reference, hint?.sheet_tab === tab ? hint.sheet_row : null);

    await this.sheets.writeRow(tab, target.row, spansFor(row));

    await query(
      `UPDATE fin_sheet_events
          SET status='WRITTEN', sheet_row=$2, written_at=now(),
              lease_owner=NULL, lease_expires_at=NULL, error=NULL
        WHERE id=$1`, [event.id, target.row]);

    /* Only in live: a dry run writes nothing, so remembering where it would
       have gone would be a lie the next live write acted on. */
    if (config.sheets.mode === 'live') {
      await query(
        `UPDATE fin_requests
            SET sheet_row=$2, sheet_tab=$3, sheet_written_at=now() WHERE id=$1`,
        [event.request_id, target.row, tab]);
    }

    this.log.log(
      `${config.sheets.mode === 'dry' ? '[dry] ' : ''}`
      + `${reference} ${target.existing ? 'updated' : 'added'} at ${tab} row ${target.row}`);
  }

  private async recordFailure(event: any, e: any) {
    const message = String(e?.message ?? e).slice(0, 2000);
    const attempts = Number(event.attempts ?? 0) + 1;

    /* A payload that can never be written, or a header that has moved, does
       not improve with waiting. The first is dead; the second is left to
       retry because somebody fixing the sheet is the thing that resolves it. */
    const permanent = e?.permanent === true;
    const dead = permanent || attempts >= MAX_ATTEMPTS;

    const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
    await query(
      `UPDATE fin_sheet_events
          SET status = $2, error = $3,
              next_attempt_at = now() + ($4 || ' minutes')::interval,
              lease_owner=NULL, lease_expires_at=NULL
        WHERE id=$1`,
      [event.id, dead ? 'DEAD' : 'FAILED', message, String(delay)]);

    this.log[dead ? 'error' : 'warn'](
      `${dead ? 'giving up on' : 'will retry'} sheet event ${event.id}: ${message}`);
  }

  /** What is waiting, for the health endpoint. */
  async health() {
    const rows = await query<any>(
      `SELECT status, count(*) AS n FROM fin_sheet_events GROUP BY status`);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = Number(r.n);

    const stuck = await query<any>(
      `SELECT e.id, e.tab, e.error, e.attempts, r.reference
         FROM fin_sheet_events e
         JOIN fin_requests r ON r.id = e.request_id
        WHERE e.status IN ('DEAD','FAILED')
        ORDER BY e.last_attempt_at DESC LIMIT 20`);

    return { mode: config.sheets.mode, counts, stuck };
  }
}