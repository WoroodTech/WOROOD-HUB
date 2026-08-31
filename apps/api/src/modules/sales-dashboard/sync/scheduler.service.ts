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
      this.log.log('scheduled sync disabled (SHOPIFY_SCHEDULE_ENABLED is not true)');
      return;
    }
    if (this.shopify.source.kind !== 'live') {
      this.log.log('scheduled sync skipped: the Shopify source is not live');
      return;
    }

    this.every(15 * 60_000, 'reconciliation', () => this.sync.reconcile());
    // Three days at hour grain: today and yesterday for the pulse strip, plus
    // one day of slack so a restart cannot leave a gap.
    this.every(60 * 60_000, 'hourly snapshot', () => this.snapshots.captureHourly(3));

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

    this.log.log('scheduled sync started');
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * One job, run on an interval, never able to kill its own timer. The catch is
   * the whole point: a Shopify outage should cost one cycle, not the schedule.
   */
  private every(ms: number, name: string, job: () => Promise<unknown>) {
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
  }
}