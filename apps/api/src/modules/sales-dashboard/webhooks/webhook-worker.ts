/**
 * The durable webhook worker.
 *
 * PostgreSQL is the queue. Not Redis, and not the process's own event loop --
 * both of which the previous path depended on, and both of which lose work
 * without telling anyone. A Redis list entry vanishes when Redis restarts; a
 * `setImmediate` callback vanishes when the process does, leaving a row that
 * says PENDING for ever and a merchant wondering where their order went.
 *
 * Here an event is only ever picked up by querying for it, so the question
 * "what still needs doing" has one answer and it survives everything.
 *
 * The loop, per event:
 *
 *   CLAIM     one UPDATE ... FOR UPDATE SKIP LOCKED -> PROCESSING with a lease
 *   APPLY     the payload, through the same code the inline path uses
 *   COMPLETE  one UPDATE conditional on still owning the lease
 *   ANNOUNCE  publish, snapshots, hydration -- only if COMPLETE returned a row
 *
 * The reasoning for that order, and for why APPLY deliberately does not check
 * the lease, is in webhook-lifecycle.ts. This file implements it.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { query, one } from '../../../common/db';
import { config } from '../../../common/config';
import { WebhookProcessor } from './webhook-processor';
import {
  LEASE_SECONDS, MAX_ATTEMPTS, afterFailure,
} from './webhook-lifecycle';

/** How often to look for leases whose holder has gone away. */
const SWEEP_MS = 30_000;

/** Renewed at a third of the lease, so two renewals can fail before work that
 *  is genuinely still running loses its claim. */
const RENEW_MS = (LEASE_SECONDS * 1000) / 3;

interface ClaimedEvent {
  id: string;
  topic: string;
  payload: any;
  triggered_at: Date | null;
  attempts: number;
}

@Injectable()
export class WebhookWorker implements OnApplicationShutdown {
  private readonly log = new Logger('WebhookWorker');
  private readonly me = config.webhookWorker.id;

  private running = false;
  private stopping = false;
  /** Resolves when the loop has finished the event in flight and returned. */
  private idle: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private processor: WebhookProcessor) {}

  /* ------------------------------------------------------------- lifetime -- */

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.log.log(`webhook worker ${this.me} started (lease ${LEASE_SECONDS}s, poll ${config.webhookWorker.pollMs}ms)`);

    /* Before taking anything new: whatever this process was holding when it
       died is still marked PROCESSING with a lease that has not yet expired.
       Nobody else will touch it until it does, and it is plainly abandoned --
       the owner is this process id and this process has just started. */
    void this.reclaimOwn();

    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredLeases().catch((e) =>
        this.log.error(`lease sweep failed: ${e?.message ?? e}`));
    }, SWEEP_MS);
    this.sweepTimer.unref?.();

    this.idle = this.loop();
  }

  /**
   * Stop taking work, finish what is in hand, and give back the claim.
   *
   * The lease means a hard kill costs only the sweep interval, but a clean
   * shutdown should cost nothing at all: the event goes back to PENDING
   * immediately and the next worker takes it on its next poll.
   */
  async onApplicationShutdown(signal?: string) {
    if (!this.running) return;
    this.log.log(`webhook worker ${this.me} stopping (${signal ?? 'shutdown'})`);
    this.stopping = true;
    this.wake?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    await this.idle;
    this.running = false;
    this.log.log(`webhook worker ${this.me} stopped`);
  }

  /** Called when an event is enqueued in-process, so a worker sharing the API
   *  process does not wait out its poll interval. Latency only. */
  notify() { this.wake?.(); }

  /* ----------------------------------------------------------------- loop -- */

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let did = false;
      try {
        did = await this.runOnce();
      } catch (e: any) {
        /* The loop itself failing -- the database being unreachable, say --
           must not end the worker. It waits and asks again; systemd restarting
           the process would achieve nothing a pause does not. */
        this.log.error(`worker loop error: ${e?.message ?? e}`);
        await this.pause(config.webhookWorker.pollMs);
      }
      // Straight back for more while there is work; otherwise wait to be woken.
      if (!did && !this.stopping) await this.pause(config.webhookWorker.pollMs);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      t.unref?.();
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }

  /** One event, start to finish. Returns false when there was nothing to do. */
  async runOnce(): Promise<boolean> {
    const ev = await this.claim();
    if (!ev) return false;

    const renew = setInterval(() => {
      void this.renew(ev.id).catch(() => undefined);
    }, RENEW_MS);
    renew.unref?.();

    try {
      const applied = await this.processor.applyEvent(ev.topic, ev.payload, ev.triggered_at);
      const state = applied ? 'PROCESSED' : 'STALE';

      const owned = await this.complete(ev.id, state, null, null);
      if (!owned) {
        /* Lost the lease while working. The event has been applied -- every
           write on that path is guarded and idempotent -- but recording the
           outcome and announcing it belong to whoever holds the claim now. */
        this.log.warn(
          `event=${ev.id} topic=${ev.topic} outcome=lost-lease note="applied but not finalized; another worker owns it"`);
        return true;
      }

      this.log.log(`event=${ev.id} topic=${ev.topic} outcome=${state.toLowerCase()} attempts=${ev.attempts + 1}`);

      if (applied) {
        /* Deliberately outside the try that records a failure: by this point
           the event IS processed, and a hydration that cannot reach Shopify
           must not reopen a finished event or push it toward DEAD. */
        await this.processor.announce(ev.topic, ev.payload).catch((e) =>
          this.log.warn(`event=${ev.id} announce failed (already processed): ${e?.message ?? e}`));
      }
      return true;
    } catch (e: any) {
      await this.fail(ev, e);
      return true;
    } finally {
      clearInterval(renew);
    }
  }

  /* ---------------------------------------------------------------- claim -- */

  /**
   * Take the oldest due event, atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes several workers safe: the inner
   * SELECT locks the row it picks, and a second worker running the same
   * statement at the same instant steps over that row rather than blocking on
   * it or taking it as well. Without SKIP LOCKED the workers would serialise
   * behind each other and -- worse -- the losing one would wake up to a row
   * that had changed underneath its snapshot.
   *
   * The predicate and its ordering match sd_webhook_events_claimable_idx
   * exactly, so this stays an index scan of outstanding work rather than a
   * sequential scan of every webhook ever received.
   */
  private async claim(): Promise<ClaimedEvent | null> {
    const rows = await query<ClaimedEvent>(
      `UPDATE sd_webhook_events
          SET status = 'PROCESSING',
              lease_owner = $1,
              lease_expires_at = now() + ($2 || ' seconds')::interval,
              last_attempt_at = now()
        WHERE id = (
          SELECT id FROM sd_webhook_events
           WHERE status IN ('PENDING','FAILED')
             AND next_attempt_at IS NOT NULL
             AND next_attempt_at <= now()
           ORDER BY next_attempt_at, received_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING id, topic, payload, triggered_at, attempts`,
      [this.me, String(LEASE_SECONDS)]);
    return rows[0] ?? null;
  }

  /**
   * Record the outcome, if and only if the claim is still ours and still live.
   *
   * Both halves matter. `lease_owner = me` stops a worker finalizing an event
   * that has since been reclaimed and handed to somebody else;
   * `lease_expires_at > now()` stops it finalizing one whose lease merely ran
   * out and is waiting to be swept. Either way the right answer is to write
   * nothing: the status is a single value, and a stalled worker writing its
   * own outcome could overwrite PROCESSED with FAILED, revive an event another
   * worker retired, or reset the attempt count so a payload that cannot
   * succeed never reaches DEAD.
   */
  private async complete(
    id: string, state: string, error: string | null, nextAttemptAt: Date | null,
  ): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE sd_webhook_events
          SET status = $3,
              processed_at = now(),
              last_attempt_at = now(),
              attempts = attempts + 1,
              error = $4,
              next_attempt_at = $5,
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE id = $1
          AND status = 'PROCESSING'
          AND lease_owner = $2
          AND lease_expires_at > now()
        RETURNING id`,
      [id, this.me, state, error, nextAttemptAt]);
    return rows.length > 0;
  }

  /** Extend a claim on work that is genuinely still running. Conditional on
   *  ownership for the same reason completion is. */
  private async renew(id: string): Promise<void> {
    await query(
      `UPDATE sd_webhook_events
          SET lease_expires_at = now() + ($3 || ' seconds')::interval
        WHERE id = $1 AND status = 'PROCESSING'
          AND lease_owner = $2 AND lease_expires_at > now()`,
      [id, this.me, String(LEASE_SECONDS)]);
  }

  /* -------------------------------------------------------------- failure -- */

  private async fail(ev: ClaimedEvent, e: any): Promise<void> {
    const attempts = ev.attempts + 1;
    const { state, retryInSeconds } = afterFailure(attempts);
    const next = retryInSeconds === null
      ? null : new Date(Date.now() + retryInSeconds * 1000);
    const message = String(e?.message ?? e).slice(0, 500);

    const owned = await this.complete(ev.id, state, message, next);
    if (!owned) {
      this.log.warn(`event=${ev.id} outcome=lost-lease note="failed, but another worker owns it now"`);
      return;
    }

    if (state === 'DEAD') {
      this.log.error(
        `event=${ev.id} topic=${ev.topic} outcome=dead attempts=${attempts} error="${message}"`);
    } else {
      this.log.warn(
        `event=${ev.id} topic=${ev.topic} outcome=retry attempts=${attempts} in=${retryInSeconds}s error="${message}"`);
    }
  }

  /* ------------------------------------------------------------- recovery -- */

  /**
   * Hand back work abandoned by a worker that is no longer running.
   *
   * The lease is what makes a crash recoverable rather than terminal: a row
   * left PROCESSING by a process that died is invisible to every backlog count
   * and indistinguishable from success, which is the worst place for a lost
   * order to hide.
   *
   * The attempt is counted. It is the one place the lifecycle notes said to
   * decide, and the alternative is worse: an event whose payload reliably kills
   * its worker would otherwise be reclaimed for ever, taking down each worker
   * that picks it up, with nothing in the data to show why. Counting it means
   * such an event reaches DEAD and becomes somebody's problem instead of
   * everybody's. The cost is that a worker killed by an unrelated deploy
   * spends one of the event's six attempts, which the retry budget absorbs.
   */
  async sweepExpiredLeases(): Promise<number> {
    const rows = await query<{ id: string; attempts: number; status: string }>(
      `UPDATE sd_webhook_events
          SET status = CASE WHEN attempts + 1 >= $1 THEN 'DEAD' ELSE 'PENDING' END,
              attempts = attempts + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = CASE WHEN attempts + 1 >= $1 THEN NULL ELSE now() END,
              error = CASE WHEN attempts + 1 >= $1
                           THEN 'abandoned repeatedly: lease expired with no result'
                           ELSE error END,
              processed_at = CASE WHEN attempts + 1 >= $1 THEN now() ELSE processed_at END
        WHERE status = 'PROCESSING' AND lease_expires_at <= now()
        RETURNING id, attempts, status`,
      [MAX_ATTEMPTS]);

    for (const r of rows) {
      if (r.status === 'DEAD') {
        this.log.error(`event=${r.id} outcome=dead reason=abandoned attempts=${r.attempts}`);
      } else {
        this.log.warn(`event=${r.id} outcome=reclaimed attempts=${r.attempts}`);
      }
    }
    if (rows.length) this.log.log(`reclaimed ${rows.length} abandoned event(s)`);
    return rows.length;
  }

  /**
   * Events this process was holding before it restarted.
   *
   * Same identity, so the lease cannot belong to a live worker: there is only
   * one process with this id, and it is this one, and it has just started. No
   * need to wait out the expiry.
   */
  private async reclaimOwn(): Promise<void> {
    try {
      const rows = await query<{ id: string }>(
        `UPDATE sd_webhook_events
            SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
                next_attempt_at = now()
          WHERE status = 'PROCESSING' AND lease_owner = $1
          RETURNING id`, [this.me]);
      if (rows.length) {
        this.log.warn(`recovered ${rows.length} event(s) held by a previous run of ${this.me}`);
      }
    } catch (e: any) {
      this.log.error(`could not recover own leases: ${e?.message ?? e}`);
    }
  }

  /* --------------------------------------------------------------- health -- */

  /** What the worker would report about itself. Read by Phase 8. */
  async backlog(): Promise<Record<string, number>> {
    const row = await one<any>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING')::int                        AS pending,
         count(*) FILTER (WHERE status = 'PROCESSING')::int                     AS processing,
         count(*) FILTER (WHERE status = 'FAILED')::int                         AS failed,
         count(*) FILTER (WHERE status = 'DEAD')::int                           AS dead,
         count(*) FILTER (WHERE status = 'PROCESSING'
                            AND lease_expires_at <= now())::int                 AS abandoned,
         count(*) FILTER (WHERE status IN ('PENDING','FAILED')
                            AND next_attempt_at IS NOT NULL
                            AND next_attempt_at <= now())::int                  AS due
         FROM sd_webhook_events`);
    return {
      pending: row?.pending ?? 0, processing: row?.processing ?? 0,
      failed: row?.failed ?? 0, dead: row?.dead ?? 0,
      abandoned: row?.abandoned ?? 0, due: row?.due ?? 0,
      maxAttempts: MAX_ATTEMPTS,
    };
  }

}