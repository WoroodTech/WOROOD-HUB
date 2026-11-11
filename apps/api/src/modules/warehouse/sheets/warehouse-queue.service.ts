/**
 * Getting movements into the spreadsheet.
 *
 * A queue rather than a direct write. The sheet can be slow, held open by
 * somebody editing it, or briefly unreachable, and none of those should lose
 * a movement the person at the keyboard has already been told was saved.
 *
 * Claimed with `FOR UPDATE SKIP LOCKED` so two workers never take the same
 * row, and leased so a process that dies mid-write leaves something that
 * expires rather than a row nobody will pick up again.
 */
import { Injectable, Logger } from '@nestjs/common';
import { one, query } from '../../../common/db';
import {
  WarehouseSheetClient, WarehouseSheetOffError, WarehouseSheetShapeError,
} from './warehouse-sheet.client';
import { WarehouseReaderService } from './warehouse-reader.service';
import { ITEMS_SHAPE, ITEMS_TAB, TX_SHAPE, TX_TAB } from './tabs';

/** What a queued event writes. */
export type WarehouseEventKind = 'LEDGER_ROW' | 'ITEM';

/**
 * How many times a write is tried before somebody has to look at it.
 *
 * Eight attempts with the backoff below spans about four hours — long enough
 * to ride out a maintenance window, short enough that a genuinely broken
 * event does not retry for days.
 */
const MAX_ATTEMPTS = 8;

/** Which tab each kind lands on, and the shape checked before writing. */
const TARGET: Record<WarehouseEventKind, { tab: string; shape: Record<string, number> }> = {
  LEDGER_ROW: { tab: TX_TAB, shape: TX_SHAPE },
  ITEM: { tab: ITEMS_TAB, shape: ITEMS_SHAPE },
};

@Injectable()
export class WarehouseQueueService {
  private readonly log = new Logger('WarehouseQueue');
  /** Tabs whose shape this process has already checked. */
  private readonly shapeChecked = new Set<string>();

  constructor(
    private readonly sheet: WarehouseSheetClient,
    private readonly reader: WarehouseReaderService,
  ) {}

  /**
   * Put a row in the queue.
   *
   * Returns as soon as it is stored. The caller has not waited for Google,
   * and should not: the row is durable here, and the worker behind it is what
   * gets it to the sheet.
   */
  async enqueue(kind: WarehouseEventKind, row: any[], sourceId?: string) {
    const ev = await one<any>(
      `INSERT INTO wh_sheet_events (kind, source_id, payload)
       VALUES ($1, $2, $3) RETURNING id`,
      [kind, sourceId ?? null, JSON.stringify({ row })]);
    return ev.id as string;
  }

  /** Claim one event, lease it, and return it. */
  private async claim(owner: string) {
    const rows = await query<any>(
      `UPDATE wh_sheet_events
          SET status = 'SENDING', attempts = attempts + 1, last_attempt_at = now(),
              lease_owner = $1, lease_expires_at = now() + interval '2 minutes'
        WHERE id = (
          SELECT id FROM wh_sheet_events
           WHERE status IN ('PENDING', 'FAILED')
             AND next_attempt_at <= now()
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`, [owner]);
    return rows[0] ?? null;
  }

  /**
   * Write everything that is waiting.
   *
   * One at a time. The Sheets API is rate-limited per document, and a burst
   * of parallel appends against one spreadsheet earns a 429 that has to be
   * unpicked per row — for a saving of seconds on work nobody is watching.
   */
  async drain(owner: string, max = 50): Promise<{ written: number; failed: number }> {
    let written = 0, failed = 0;

    for (let i = 0; i < max; i++) {
      const ev = await this.claim(owner);
      if (!ev) break;

      try {
        const target = TARGET[ev.kind as WarehouseEventKind];
        if (!target) throw new Error(`unknown event kind ${ev.kind}`);

        /*
         * The shape is checked once per tab per process, before the first
         * write touches it. If somebody has inserted a column, a quantity
         * would otherwise land in the warehouse column — and the sheet would
         * take it without complaint.
         */
        if (!this.shapeChecked.has(target.tab)) {
          await this.sheet.assertShape(target.tab, target.shape);
          this.shapeChecked.add(target.tab);
        }

        const where = await this.sheet.append(target.tab, ev.payload.row);

        await query(
          `UPDATE wh_sheet_events
              SET status='WRITTEN', written_at=now(), written_tab=$2, written_row=$3,
                  error=NULL, lease_owner=NULL, lease_expires_at=NULL
            WHERE id=$1`, [ev.id, where.tab, where.rowNumber]);

        written++;
      } catch (e: any) {
        failed++;
        await this.recordFailure(ev, e);
      }
    }

    /* Anything that landed changes what the sheet says, so what was read
       before is no longer what is there. */
    if (written) await this.reader.invalidate();

    return { written, failed };
  }

  /**
   * Note why a write did not happen, and when to try again.
   */
  private async recordFailure(ev: any, e: any) {
    /*
     * Switched off is not a failure, so it must not spend an attempt.
     *
     * Somebody turning the connection off is a decision, not something wrong
     * with this movement. Counting it would let a weekend in dry mode exhaust
     * the retries and kill rows that were always going to be fine the moment
     * it was switched back on.
     */
    if (e instanceof WarehouseSheetOffError) {
      await query(
        `UPDATE wh_sheet_events
            SET status='FAILED', error=$2,
                attempts = GREATEST(0, attempts - 1),
                next_attempt_at = now() + interval '5 minutes',
                lease_owner=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [ev.id, 'Waiting: the warehouse sheet connection is not live.']);
      return;
    }

    /*
     * A moved column is not something retrying fixes, and retrying it is
     * actively bad: the next attempt would write into whatever the columns
     * are now. It stops here, visibly, for somebody to look at the sheet.
     */
    if (e instanceof WarehouseSheetShapeError) {
      this.shapeChecked.clear();
      await query(
        `UPDATE wh_sheet_events
            SET status='DEAD', error=$2, lease_owner=NULL, lease_expires_at=NULL
          WHERE id=$1`, [ev.id, String(e.message).slice(0, 1000)]);
      this.log.error(`shape mismatch, queue halted: ${e.message}`);
      return;
    }

    const attempts = Number(ev.attempts ?? 0);
    const dead = attempts >= MAX_ATTEMPTS;
    /* 30s, 1m, 2m, 4m … capped at an hour. */
    const backoffSec = Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);

    await query(
      `UPDATE wh_sheet_events
          SET status=$2, error=$3,
              next_attempt_at = now() + ($4 || ' seconds')::interval,
              lease_owner=NULL, lease_expires_at=NULL
        WHERE id=$1`,
      [ev.id, dead ? 'DEAD' : 'FAILED',
       String(e?.message ?? e).slice(0, 1000), String(backoffSec)]);

    this.log[dead ? 'error' : 'warn'](
      `event ${ev.id} (${ev.kind}) ${dead ? 'gave up' : 'failed'} after `
      + `${attempts} attempt(s): ${e?.message ?? e}`);
  }

  /**
   * Give back a lease held by a process that is gone.
   *
   * Without this an event claimed by a worker that was killed mid-write stays
   * `SENDING` for ever, and nothing retries it.
   */
  async reclaimExpiredLeases(): Promise<number> {
    const rows = await query<any>(
      `UPDATE wh_sheet_events
          SET status='FAILED', lease_owner=NULL, lease_expires_at=NULL,
              error = COALESCE(error, 'The worker holding this stopped before it finished.')
        WHERE status='SENDING' AND lease_expires_at < now()
        RETURNING id`);
    if (rows.length) this.log.warn(`reclaimed ${rows.length} expired lease(s)`);
    return rows.length;
  }

  /** What the queue looks like, for the health screen. */
  async health() {
    const rows = await query<any>(
      `SELECT status, count(*)::int AS n FROM wh_sheet_events GROUP BY status`);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.n;

    const oldest = await one<any>(
      `SELECT created_at FROM wh_sheet_events
        WHERE status IN ('PENDING','FAILED') ORDER BY created_at LIMIT 1`);

    const stuck = await query<any>(
      `SELECT id, kind, error, attempts FROM wh_sheet_events
        WHERE status='DEAD' ORDER BY last_attempt_at DESC LIMIT 10`);

    return {
      mode: this.sheet.mode,
      configured: this.sheet.configured,
      byStatus,
      oldestWaitingAt: oldest?.created_at ?? null,
      dead: stuck.map((s) => ({
        id: s.id, kind: s.kind, error: s.error, attempts: Number(s.attempts),
      })),
    };
  }
}