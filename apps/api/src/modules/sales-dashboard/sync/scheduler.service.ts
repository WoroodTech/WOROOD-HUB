/**
 * The clock behind the sales pipeline.
 *
 * Everything here already existed as a method somebody could POST to from the
 * Data & Sync screen. What did not exist was anything calling them on a timer,
 * so in practice the mirror only advanced when a human remembered -- and the
 * failure mode that makes internal dashboards untrustworthy is exactly that:
 * it keeps rendering yesterday's numbers and nobody notices for a week.
 *
 * Four cadences, each with a reason rather than a round number:
 *
 *   reconciliation   every 15 min   the practical upper bound on how long a
 *                                   missed webhook can go unnoticed
 *   hourly snapshot  every hour     today and yesterday at hour grain, for the
 *                                   pulse strip and the intraday chart
 *   nightly snapshot 02:00 Cairo    thirteen months at day grain, which also
 *                                   corrects figures Shopify has since revised
 *   watchdog         03:00 Cairo    Shopify deletes a subscription after eight
 *                                   consecutive failures, silently
 *
 * Off unless `SHOPIFY_SCHEDULE_ENABLED=true`. A developer running the API on a
 * laptop should not start calling Shopify on a timer -- and more to the point,
 * two machines pointed at the same store would both reconcile, both snapshot,
 * and burn the rate-limit budget twice for one set of numbers.
 *
 * Each job is wrapped so a failure is logged and the schedule survives it. An
 * unhandled rejection inside a cron callback takes down the interval in some
 * runtimes, which would stop the pipeline quietly -- the precise outcome all of
 * this exists to prevent.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { config } from '../../../common/config';
import { ShopifyService } from '../shopify/shopify.service';
import { SnapshotService } from '../analytics/snapshot.service';
import { SyncService } from './sync.service';

/** Cairo wall-clock hour right now, for the two jobs that should run overnight
 *  in Worood's own time rather than the server's. */
const cairoHour = (): number =>
  Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false,
  }).format(new Date()));

@Injectable()
export class SalesScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SalesScheduler');
  private timers: NodeJS.Timeout[] = [];
  private lastNightly = '';
  private lastWatchdog = '';

  constructor(
    private sync: SyncService,
    private snapshots: SnapshotService,
    private shopify: ShopifyService,
  ) {}

  onModuleInit() {
    if (!config.shopify.scheduleEnabled) {
      this.log.log('scheduled sync disabled (SHOPIFY_SCHEDULE_ENABLED=false)');
      return;
    }
    if (this.shopify.source.kind !== 'live') {
      this.log.log('scheduled sync skipped: the Shopify source is not live');
      return;
    }

    /* Reconciliation refreshes the snapshots when it actually wrote something.
       Without this, an order that arrived by reconciliation rather than by
       webhook -- a missed delivery, a tunnel that was down, anything the
       fifteen-minute sweep exists to catch -- lands in the mirror and leaves
       every headline figure untouched until the top of the hour. The two lanes
       have to be joined on both paths, not only the fast one. */
    this.every(15 * 60_000, 'reconciliation', async () => {
      const written = await this.sync.reconcile();
      /* Ask for a capture, but let the debounce and the in-flight lock in
         SnapshotService decide whether one actually runs. On a cold start this
         and the hourly job fire seconds apart; both used to proceed, which was
         four ShopifyQL queries at once and a throttled failure. */
      if (written > 0) this.snapshots.scheduleRefresh(60_000);
      return written;
    }, { runAtStartup: true, startupDelayMs: 10_000 });

    /* Day grain as well as hour grain, every hour.
     *
     * This used to capture hours only, on the reasoning that a day-grain row
     * for last March cannot change. True, but the dashboard's freshness banner
     * reports the age of the *oldest* figure on the page against a 180-minute
     * budget -- and day rows refreshed only by the nightly job are up to
     * twenty-four hours old. The banner was therefore guaranteed to appear
     * every afternoon whether or not anything was actually wrong, which is the
     * fastest way to teach people to ignore it.
     *
     * Two ShopifyQL queries and an upsert of a few hundred rows, hourly. The
     * nightly job stays: it is the one that also refreshes breakdowns and
     * corrects figures Shopify has since revised.
     */
    this.every(60 * 60_000, 'hourly snapshot',
      () => this.snapshots.refreshRecent(),
      { runAtStartup: true, startupDelayMs: 20_000 });

    /* The overnight jobs are checked every ten minutes rather than scheduled at
       an offset from start-up: a process restarted at 01:59 would otherwise
       wait a full day. The date guard is what keeps them to once. */
    this.every(10 * 60_000, 'overnight', async () => {
      const today = new Date().toISOString().slice(0, 10);

      if (cairoHour() === 2 && this.lastNightly !== today) {
        this.lastNightly = today;
        this.log.log('nightly snapshot: thirteen months at day grain');
        await this.snapshots.captureDaily();
        await this.snapshots.captureBreakdowns();
      }
      if (cairoHour() === 3 && this.lastWatchdog !== today) {
        this.lastWatchdog = today;
        await this.sync.verifyWebhooks();
        await this.sync.runRetention();
      }
    });

    this.log.log(
      'scheduled sync started — reconcile 15m, snapshots hourly, ' +
      'nightly 02:00 Cairo, watchdog 03:00 Cairo');
  }

  onModuleDestroy() {
    // Both kinds live in one list; clearing an id with the wrong function is a
    // no-op in Node, so one pass with each is simpler than tracking types.
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
  }

  /**
   * One job, run on an interval, never able to kill its own timer. The catch is
   * the whole point: a Shopify outage should cost one cycle, not the schedule.
   */
  private every(
    ms: number,
    name: string,
    job: () => Promise<unknown>,
    { runAtStartup = false, startupDelayMs = 0 } = {},
  ) {
    let running = false;
    const tick = async () => {
      // Skip rather than overlap. A reconciliation that takes longer than its
      // own interval would otherwise stack, and two concurrent passes over the
      // same watermark is how a mirror ends up fighting itself.
      if (running) { this.log.warn(`${name}: previous run still going, skipping`); return; }
      running = true;
      try {
        await job();
      } catch (e: any) {
        this.log.error(`${name} failed: ${e?.message ?? e}`);
      } finally {
        running = false;
      }
    };
    this.timers.push(setInterval(tick, ms));

    /* `setInterval` fires after the first period, not at zero.
     *
     * That gap is why a freshly started server reported "the oldest figure was
     * read 22 hours ago" and kept reporting it: nothing had run yet, and
     * nothing would until a whole interval elapsed. On the overnight jobs it is
     * worse -- a process restarted at 01:59 would wait until 02:59.
     *
     * The startup delay is not decoration. It keeps these off the critical path
     * while the first requests are served, and it staggers the jobs so they do
     * not all call Shopify in the same second.
     */
    if (runAtStartup) {
      const t = setTimeout(() => {
        this.log.log(`${name}: initial run`);
        void tick();
      }, startupDelayMs);
      this.timers.push(t as unknown as NodeJS.Timeout);
    }
  }
}