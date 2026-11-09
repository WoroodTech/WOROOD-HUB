/**
 * One comment, put on many orders.
 *
 * Two phases, and the split is the whole design:
 *
 *   **Check.** Every reference in the file is resolved against the orders
 *   this portal holds. Nothing is published. If one reference matches no
 *   order, the run is refused and says which — so the file can be fixed and
 *   sent again with nothing half-done behind it.
 *
 *   **Publish.** Only once every reference resolved. Orders are done one at
 *   a time; what succeeds stays, what fails is recorded with its reason, and
 *   the run carries on. Stopping at the first failure would leave the rest
 *   untouched for a reason that may apply only to that one order.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { one, query } from '../../../common/db';
import { Principal } from '../../../common/auth';
import { AuditService } from '../../../core/core.module';
import { OrderNotesService } from './order-notes.service';

/**
 * The ceiling.
 *
 * Five hundred orders is about four minutes of Shopify calls. Past that a run
 * stops being something somebody waits for and starts being something they
 * forget they started, and a mistake in the file costs proportionally more to
 * undo — which, for a published comment, means by hand.
 */
export const MAX_ORDERS = 500;

@Injectable()
export class BulkCommentsService {
  private readonly log = new Logger('BulkComments');
  /** Runs this process is already working through, so none is started twice. */
  private readonly running = new Set<string>();

  constructor(
    private readonly notes: OrderNotesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Take the file and check it.
   *
   * Returns as soon as the check is done — which is database work only, fast
   * even at five hundred rows. Publishing starts behind the response.
   */
  async start(p: Principal, body: string, references: string[]) {
    const text = (body ?? '').trim();
    if (!text) throw new BadRequestException('Write the comment first.');
    if (text.length > 4000) {
      throw new BadRequestException('That comment is too long for an order note.');
    }

    /* Normalised and de-duplicated before counting, so a file with the same
       order twice is not two of the five hundred — and does not get the
       comment twice, which cannot be undone from here. */
    const seen = new Map<string, string>();
    for (const raw of references) {
      const ref = String(raw ?? '').trim();
      if (!ref) continue;
      const key = ref.replace(/^#/, '').toLowerCase();
      if (!seen.has(key)) seen.set(key, ref);
    }
    const unique = [...seen.values()];

    if (!unique.length) {
      throw new BadRequestException('That file has no order references in it.');
    }
    if (unique.length > MAX_ORDERS) {
      throw new BadRequestException(
        `That file has ${unique.length} orders. The most that can go in one `
        + `run is ${MAX_ORDERS} — split it and send the rest separately.`);
    }

    const run = await one<any>(
      `INSERT INTO sd_bulk_comments (author_id, body, total)
       VALUES ($1,$2,$3) RETURNING id`, [p.id, text, unique.length]);

    const missing = await this.resolve(run.id, unique);

    if (missing.length) {
      /*
       * Refused whole, with nothing published.
       *
       * A file is usually wrong in one way — an export from the wrong date
       * range, a column that picked up a header row. Naming every reference
       * that failed lets it be fixed in one pass rather than one run per
       * mistake. Capped, because a file where nothing matches would otherwise
       * return five hundred lines nobody reads.
       */
      const shown = missing.slice(0, 10);
      const reason =
        `No order matches ${missing.length === 1 ? 'this reference' : 'these references'}: `
        + shown.join(', ')
        + (missing.length > shown.length ? `, and ${missing.length - shown.length} more.` : '.')
        + ' Nothing was published — fix the file and send it again.';

      await query(
        `UPDATE sd_bulk_comments SET status='REFUSED', refused_reason=$2,
                finished_at=now() WHERE id=$1`, [run.id, reason]);

      return { id: run.id, status: 'REFUSED' as const, total: unique.length, missing, reason };
    }

    await query(
      `UPDATE sd_bulk_comments SET status='RUNNING', started_at=now() WHERE id=$1`,
      [run.id]);

    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'sales.order.bulk_comment',
      entityType: 'bulk_comment', entityId: run.id,
      payload: { orders: unique.length },
    });

    /* Deliberately not awaited: the response goes back now and the work
       carries on behind it. Errors are caught inside `publish`, so nothing
       escapes into an unhandled rejection. */
    void this.publish(run.id, p);

    return { id: run.id, status: 'RUNNING' as const, total: unique.length, missing: [], reason: null };
  }

  /**
   * Match every reference to an order, and write the targets down.
   *
   * Done as one query rather than five hundred: the references go in as an
   * array and come back joined. Matching ignores a leading `#` and case,
   * because an export from Shopify and one from a spreadsheet disagree about
   * both and neither is wrong.
   */
  private async resolve(runId: string, references: string[]): Promise<string[]> {
    const rows = await query<any>(
      `WITH given(reference) AS (SELECT unnest($2::text[]))
       INSERT INTO sd_bulk_comment_targets (run_id, reference, order_id)
       SELECT $1, g.reference, o.id
         FROM given g
         LEFT JOIN sd_orders o
           ON lower(ltrim(o.name, '#')) = lower(ltrim(g.reference, '#'))
          AND o.deleted_at IS NULL
       RETURNING reference, order_id`,
      [runId, references]);

    return rows.filter((r) => !r.order_id).map((r) => r.reference);
  }

  /**
   * Put the comment on each order.
   *
   * One at a time, on purpose. Shopify rate-limits, and a burst of parallel
   * writes earns a 429 that would have to be unpicked per order; the gain
   * would be a minute on a run nobody is watching anyway.
   *
   * Never throws. The run is already recorded, and a failure here must leave
   * the counters readable rather than disappear into a log.
   */
  private async publish(runId: string, p: Principal) {
    if (this.running.has(runId)) return;
    this.running.add(runId);

    try {
      for (;;) {
        const next = await one<any>(
          `SELECT t.id, t.order_id, t.reference
             FROM sd_bulk_comment_targets t
            WHERE t.run_id = $1 AND t.status = 'PENDING'
            ORDER BY t.id
            LIMIT 1`, [runId]);
        if (!next) break;

        const run = await one<any>(
          `SELECT body, status FROM sd_bulk_comments WHERE id = $1`, [runId]);
        /* Cancelled from the screen while this was running. */
        if (!run || run.status === 'CANCELLED') break;

        try {
          await this.notes.add(p, next.order_id, run.body);
          await query(
            `UPDATE sd_bulk_comment_targets
                SET status='PUBLISHED', done_at=now() WHERE id=$1`, [next.id]);
          await query(
            `UPDATE sd_bulk_comments SET published = published + 1 WHERE id=$1`, [runId]);
        } catch (e: any) {
          /* Recorded against the order it happened to, and the run carries
             on: one order Shopify refuses says nothing about the next. */
          await query(
            `UPDATE sd_bulk_comment_targets
                SET status='FAILED', error=$2, done_at=now() WHERE id=$1`,
            [next.id, String(e?.message ?? e).slice(0, 500)]);
          await query(
            `UPDATE sd_bulk_comments SET failed = failed + 1 WHERE id=$1`, [runId]);
          this.log.warn(`bulk comment: ${next.reference} failed: ${e?.message ?? e}`);
        }

        /* Paced under Shopify's two-a-second, so a long run does not spend
           the shop's whole budget and starve the order sync behind it. */
        await new Promise((r) => setTimeout(r, 600));
      }

      await query(
        `UPDATE sd_bulk_comments
            SET status = CASE WHEN status='CANCELLED' THEN 'CANCELLED' ELSE 'DONE' END,
                finished_at = now()
          WHERE id = $1 AND status IN ('RUNNING','CANCELLED')`, [runId]);
    } catch (e: any) {
      this.log.error(`bulk comment run ${runId} stopped: ${e?.message ?? e}`);
      await query(
        `UPDATE sd_bulk_comments SET status='DONE', finished_at=now() WHERE id=$1`,
        [runId]).catch(() => undefined);
    } finally {
      this.running.delete(runId);
    }
  }

  /** How a run is going, for the screen to watch. */
  async status(_p: Principal, id: string) {
    const run = await one<any>(
      `SELECT c.*, u.full_name AS author_name
         FROM sd_bulk_comments c
         JOIN core_users u ON u.id = c.author_id
        WHERE c.id = $1`, [id]);
    if (!run) throw new NotFoundException('No such run.');

    const failures = await query<any>(
      `SELECT reference, error FROM sd_bulk_comment_targets
        WHERE run_id = $1 AND status = 'FAILED'
        ORDER BY reference LIMIT 50`, [id]);

    return {
      id: run.id,
      status: run.status,
      body: run.body,
      authorName: run.author_name,
      total: Number(run.total),
      published: Number(run.published),
      failed: Number(run.failed),
      refusedReason: run.refused_reason,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      failures: failures.map((f) => ({ reference: f.reference, error: f.error })),
    };
  }

  /**
   * Stop a run partway.
   *
   * What has already been published stays: those comments are on orders in
   * Shopify and somebody may have read them. Cancelling means the rest will
   * not be done, not that the run is undone.
   */
  async cancel(p: Principal, id: string) {
    const run = await one<any>(
      `SELECT status FROM sd_bulk_comments WHERE id = $1`, [id]);
    if (!run) throw new NotFoundException('No such run.');
    if (run.status !== 'RUNNING') {
      throw new BadRequestException('That run is not going.');
    }
    await query(
      `UPDATE sd_bulk_comments SET status='CANCELLED', finished_at=now() WHERE id=$1`,
      [id]);
    await this.audit.write({
      actorId: p.id, moduleKey: 'sales-dashboard', action: 'sales.order.bulk_comment.cancel',
      entityType: 'bulk_comment', entityId: id, payload: {},
    });
    return { ok: true };
  }

  /** The recent runs, so somebody can find one they started earlier. */
  async recent(_p: Principal) {
    const rows = await query<any>(
      `SELECT c.id, c.status, c.total, c.published, c.failed, c.created_at,
              u.full_name AS author_name
         FROM sd_bulk_comments c
         JOIN core_users u ON u.id = c.author_id
        ORDER BY c.created_at DESC LIMIT 10`);
    return rows.map((r) => ({
      id: r.id, status: r.status, total: Number(r.total),
      published: Number(r.published), failed: Number(r.failed),
      authorName: r.author_name, createdAt: r.created_at,
    }));
  }
}