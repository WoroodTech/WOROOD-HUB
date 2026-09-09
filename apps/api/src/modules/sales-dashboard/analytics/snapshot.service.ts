/**
 * ShopifyQL capture.
 *
 * Live ShopifyQL per page view would be slow, would consume the rate-limit
 * budget unpredictably, and would make the dashboard's responsiveness a
 * function of Shopify's. Instead results are captured into sd_metric_snapshots
 * on a schedule and every widget reads from PostgreSQL.
 *
 * The unique key (shop, schema, grain, bucket_start, dimensions_hash) makes
 * re-capture an idempotent upsert, which is what lets the nightly job correct
 * thirteen months of history without duplicating anything.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { config } from '../../../common/config';
import { one, query } from '../../../common/db';
import { ShopifyService, ShopifyQlResult } from '../shopify/shopify.service';

export interface Shop {
  id: string; myshopify_domain: string; name: string; iana_timezone: string;
  currency_code: string; money_format: string | null; plan_name: string | null;
  api_version: string; cost_restore_rate: number;
}

@Injectable()
export class ShopContext {
  private cached: Shop | null = null;

  /** Drop the cached row so the next `get` re-reads it. Called after the shop's
   *  currency or timezone is pulled from Shopify -- without it the process
   *  keeps formatting money in whatever the row said at start-up, which is the
   *  hardest kind of stale to notice because nothing is broken, only labelled
   *  wrongly. */
  invalidate(): void {
    this.cached = null;
  }

  /** One row per connected store. Created on first use so the module works on a
   *  fresh database; the seeder upserts on the same unique key. */
  async get(): Promise<Shop> {
    if (this.cached) return this.cached;
    const existing = await one<Shop>(
      `SELECT * FROM sd_shops WHERE myshopify_domain = $1`, [config.shopify.shopDomain]);
    if (existing) return (this.cached = existing);

    const created = await one<Shop>(
      `INSERT INTO sd_shops (myshopify_domain, name, iana_timezone, currency_code,
                             plan_name, api_version, cost_restore_rate)
       VALUES ($1,$2,'Africa/Cairo','EGP','Advanced',$3,$4)
       ON CONFLICT (myshopify_domain) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [config.shopify.shopDomain, 'WOROOD', config.shopify.apiVersion,
       config.shopify.costRestoreRate],
    );
    return (this.cached = created);
  }
}

/** ShopifyQL rows arrive as arrays of strings aligned to the columns. */
/** One day of hourly buckets, read live rather than from the snapshot store. */
export interface HourlyDay {
  sales: Array<{ bucket: string; metrics: Record<string, number> }>;
  capturedAt: Date;
}

function toRecords(res: ShopifyQlResult): Record<string, string>[] {
  const names = res.columns.map((c) => c.name);
  return res.rows.map((row) =>
    Object.fromEntries(names.map((n, i) => [n, Array.isArray(row) ? row[i] : (row as any)[n]])));
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

@Injectable()
export class SnapshotService {
  private readonly log = new Logger('SnapshotService');

  constructor(private shopify: ShopifyService, private shops: ShopContext) {}

  // Every query passes WITH TIMEZONE explicitly rather than relying on a default
  // that Shopify does not state in prose. Day-grain series aggregate in shop
  // time while hour-grain timestamps come back in UTC, so mixing the two without
  // normalising silently shifts totals -- for Cairo, by three hours, which on a
  // partial current day can look like a factor of two.
  /* Read from the shop row, not written here.
   *
   * This was the literal string "WITH TIMEZONE 'Africa/Cairo'", which was
   * correct and was still a trap: `sd_shops.iana_timezone` is synced from
   * Shopify and is what every other part of the module reasons in, so a store
   * whose timezone changed would have had its snapshots aggregated on the old
   * one while its order queries used the new. Silent, and the design document
   * puts the size of a timezone mismatch on a partial day at roughly a factor
   * of two.
   *
   * The fallback exists only for a shop row that has not synced yet. */
  private tz(shop: Shop): string {
    return `WITH TIMEZONE '${shop.iana_timezone || 'Africa/Cairo'}'`;
  }

  salesQuery(grain: 'day' | 'hour', since: string, shop: Shop) {
    /* `sales_reversals` is asked for again.
     *
     * It was dropped when the fixtures were captured, because the column was
     * genuinely absent from the schema at the time and the query failed with
     * it. It exists now: 2026-04 renamed the old `returns` family to
     * `sales_reversals` -- same definition, clearer name, since the figure
     * always covered refunds, cancellations and edits rather than only
     * physical returns -- and 2026-07 removed the old names outright.
     *
     * With it, `net_sales = gross_sales − discounts − sales_reversals` closes
     * on Shopify's own arithmetic instead of being derived. A missing column is
     * still treated as zero rather than crashing the capture, so this is safe
     * against an older store schema; see upsert() below.
     */
    return `FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, ` +
      `shipping_charges, taxes, total_sales, average_order_value ` +
      `TIMESERIES ${grain} SINCE ${since} UNTIL today ${this.tz(shop)}`;
  }

  sessionsQuery(grain: 'day' | 'hour', since: string, shop: Shop) {
    // Bot filtering is not automatic. Omitting this clause inflates sessions and
    // depresses conversion rate, and the convention must match how Worood reads
    // the Shopify admin or the two will disagree.
    return `FROM sessions SHOW sessions, online_store_visitors, ` +
      `sessions_with_cart_additions, sessions_that_reached_checkout, ` +
      `sessions_that_completed_checkout, conversion_rate ` +
      `TIMESERIES ${grain} SINCE ${since} UNTIL today ` +
      `WHERE human_or_bot_session = 'human' ${this.tz(shop)}`;
  }

  /** Nightly: day grain over the trailing 13 months, refreshing any figure
   *  Shopify has since adjusted and keeping year-on-year honest. */
  async captureDaily(sinceDays = 395) {
    const shop = await this.shops.get();
    const sales = await this.shopify.source.shopifyql(this.salesQuery('day', `-${sinceDays}d`, shop));
    const sessions = await this.shopify.source.shopifyql(this.sessionsQuery('day', `-${sinceDays}d`, shop));
    const a = await this.upsertSeries(shop, 'sales', 'day', sales, 'day');
    const b = await this.upsertSeries(shop, 'sessions', 'day', sessions, 'day');
    await this.markSync(shop.id, 'sales_snapshot', a + b);
    this.log.log(`daily snapshots: ${a} sales + ${b} sessions buckets`);
    return a + b;
  }

  /** Hourly: current and previous day at hour grain, for the pulse strip and
   *  the intraday trend. */
  /**
   * Hourly figures for one specific day, read live from ShopifyQL.
   *
   * Not from `sd_metric_snapshots`, and that is the point. The hourly capture
   * covers three days, so the stored hour buckets only reach back as far as the
   * job has been running -- ask for a day beyond that and every figure is zero,
   * which is what the day comparison did for any date more than a week or so
   * old. ShopifyQL itself has no such limit: `TIMESERIES hour SINCE <day> UNTIL
   * <day>` answers for any date in the store's history.
   *
   * Two queries per comparison, on a deliberate user action, in exchange for
   * arbitrary history and figures whose age is zero rather than however long
   * ago that day happened to be current. The rule against querying ShopifyQL
   * per page view exists for widgets that load on every visit; this is not one.
   */
  private dayCache = new Map<string, { at: number; p: Promise<HourlyDay> }>();

  async hourlyForDay(day: string, schema: 'sales' | 'sessions' = 'sales'): Promise<HourlyDay> {
    /* One call per day per schema, however many widgets ask.
     *
     * A comparison dashboard has five widgets wanting the same two days, and
     * each was making its own ShopifyQL round trip -- ten network calls for one
     * page, spaced further apart by the cost governor. The request took long
     * enough that the browser gave up before the server answered, so the data
     * arrived at a page that had already shown "could not load this".
     *
     * Callers arriving while a fetch is in flight join it rather than starting
     * another. Ten calls become two.
     *
     * The result is held for a minute afterwards, which is what makes a page
     * refresh cheap without making the figures stale in any way anybody would
     * notice: ShopifyQL's own analytics lag is longer than that.
     */
    const key = `${schema}:${day}`;
    const hit = this.dayCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;

    const p = this.fetchHourlyForDay(day, schema);
    this.dayCache.set(key, { at: Date.now(), p });
    // A failure must not be cached, or one blip poisons the next minute.
    p.catch(() => this.dayCache.delete(key));

    /* Bounded, because the keys are user-chosen dates: somebody clicking
       through a month would otherwise grow the map forever. */
    if (this.dayCache.size > 40) {
      for (const [k, v] of this.dayCache) {
        if (Date.now() - v.at > 60_000) this.dayCache.delete(k);
      }
    }
    return p;
  }

  private async fetchHourlyForDay(
    day: string, schema: 'sales' | 'sessions',
  ): Promise<HourlyDay> {
    const shop = await this.shops.get();

    /* The store first. A day that has already been captured is answered from
       PostgreSQL, which is both faster and -- more to the point -- still works
       when Shopify does not. Reaching out to an external service while
       rendering a screen means an outage there is a blank screen here.
    
       A day is only served from the store if it is *complete*: 24 buckets, or
       the hours elapsed so far for today. A partial capture -- an hourly job
       that ran at ten past two -- would otherwise be served as the whole day
       and quietly under-report it. */
    const stored = await this.storedHoursFor(shop, day, schema);
    if (stored) return stored;

    const fetched = await this.fetchFromShopify(shop, day, schema);

    /* Written back, so the next reader gets it from the store. A day chosen
       once from a calendar is usually chosen again -- by the same person
       comparing a third day against it, or by somebody else the same week. */
    if (fetched.sales.length) {
      await this.persistHours(shop, day, schema, fetched).catch((e) =>
        this.log.warn(`could not store hourly ${schema} for ${day}: ${e?.message ?? e}`));
    }
    return fetched;
  }

  /**
   * Hourly buckets already in `sd_metric_snapshots`, or null if the day is not
   * there in full.
   *
   * Completeness is the whole question. Returning what is stored regardless
   * would mean a day captured half-way through reads as a quiet day rather than
   * a partial one, which is the kind of wrong that looks like a business
   * problem rather than a data problem.
   */
  private async storedHoursFor(
    shop: Shop, day: string, schema: 'sales' | 'sessions',
  ): Promise<HourlyDay | null> {
    const start = DateTime.fromISO(day, { zone: shop.iana_timezone }).startOf('day');
    if (!start.isValid) return null;
    const end = start.endOf('day');

    const rows = await query<any>(
      `SELECT bucket_start, metrics, captured_at FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = $2 AND grain = 'hour'
          AND dimensions = '{}'::jsonb
          AND bucket_start >= $3 AND bucket_start <= $4
        ORDER BY bucket_start`,
      [shop.id, schema, start.toJSDate(), end.toJSDate()]);

    if (!rows.length) return null;

    /* How many hours this day should have. A past day has 24; today has as many
       as have elapsed. Shopify emits no bucket for an hour with no activity, so
       a quiet night legitimately produces fewer -- hence the tolerance rather
       than an exact match. Two missing hours is a quiet shop; twelve is a
       capture that did not finish. */
    const now = DateTime.now().setZone(shop.iana_timezone);
    const isToday = start.hasSame(now, 'day');
    const expected = isToday ? now.hour + 1 : 24;
    if (rows.length < Math.max(1, Math.floor(expected * 0.5))) return null;

    // Today is never served from the store: the current hour is still moving.
    if (isToday) return null;

    return {
      sales: rows.map((r) => ({
        bucket: new Date(r.bucket_start).toISOString(),
        metrics: r.metrics as Record<string, number>,
      })),
      capturedAt: new Date(
        Math.max(...rows.map((r) => new Date(r.captured_at).getTime()))),
    };
  }

  /** Write a fetched day into the snapshot store, so it is read from there next
   *  time. Marked final, because a past day's hours do not move. */
  private async persistHours(
    shop: Shop, day: string, schema: 'sales' | 'sessions', data: HourlyDay,
  ): Promise<void> {
    const today = DateTime.now().setZone(shop.iana_timezone).toFormat('yyyy-MM-dd');
    if (day >= today) return;   // still moving; let the hourly job own it

    for (const row of data.sales) {
      await this.upsert(
        shop.id, schema, 'hour', new Date(row.bucket), {}, row.metrics, true);
    }
  }

  private async fetchFromShopify(
    shop: Shop, day: string, schema: 'sales' | 'sessions',
  ): Promise<HourlyDay> {
    const q = schema === 'sessions'
      ? `FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, ` +
        `sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate ` +
        `TIMESERIES hour SINCE ${day} UNTIL ${day} ` +
        `WHERE human_or_bot_session = 'human' ${this.tz(shop)}`
      : `FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, ` +
        `shipping_charges, taxes, total_sales, average_order_value ` +
        `TIMESERIES hour SINCE ${day} UNTIL ${day} ${this.tz(shop)}`;

    const res = await this.shopify.source.shopifyql(q);

    /* Parsed with the same `toRecords` and `num` the capture path uses, rather
       than by column index.
    
       The first version read the timestamp by position and assumed it was
       first, which threw `Invalid time value` on every widget that touched it.
       ShopifyQL returns rows as arrays or as objects depending on the query,
       and the column order is not promised -- `toRecords` already handles both
       and has done since the capture was written. Reusing it is not only less
       code; it is the difference between one parser and two that can disagree. */
    const records = toRecords(res);

    const rows = records.flatMap((rec) => {
      const raw = rec.hour ?? rec[Object.keys(rec)[0]];
      if (!raw) return [];

      /* Hour-grain values come back as UTC instants even when the query asked
         for a shop-timezone series. Normalised to an absolute instant here, so
         no caller can mix a UTC hour with a Cairo day -- the mismatch the
         design document puts at roughly a factor of two on a partial day. */
      const dt = DateTime.fromISO(String(raw), { zone: 'utc' });
      if (!dt.isValid) return [];

      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec)) if (k !== 'hour') metrics[k] = num(v);

      return [{ bucket: dt.toJSDate().toISOString(), metrics }];
    });

    return { sales: rows, capturedAt: new Date() };
  }

  async captureHourly(sinceDays = 14) {
    const shop = await this.shops.get();
    const sales = await this.shopify.source.shopifyql(this.salesQuery('hour', `-${sinceDays}d`, shop));
    const sessions = await this.shopify.source.shopifyql(this.sessionsQuery('hour', `-${sinceDays}d`, shop));
    const a = await this.upsertSeries(shop, 'sales', 'hour', sales, 'hour');
    const b = await this.upsertSeries(shop, 'sessions', 'hour', sessions, 'hour');
    return a + b;
  }

  /** Dimensional breakdowns. Stored at grain 'total' with the dimension in the
   *  dimensions column, so one widget query can read a whole breakdown. */
  async captureBreakdowns() {
    const shop = await this.shops.get();
    const jobs: Array<[string, string, string]> = [
      ['sales', 'product_title',
       `FROM sales SHOW gross_sales, net_sales, total_sales, orders GROUP BY product_title ORDER BY total_sales DESC LIMIT 50 SINCE -90d UNTIL today ${this.tz(shop)}`],
      ['traffic', 'referrer_source',
       `FROM sessions SHOW sessions GROUP BY referrer_source ORDER BY sessions DESC SINCE -30d UNTIL today`],
      ['sessions', 'session_device_type',
       `FROM sessions SHOW sessions, conversion_rate GROUP BY session_device_type SINCE -30d UNTIL today`],
      ['sessions', 'session_country',
       `FROM sessions SHOW sessions, conversion_rate GROUP BY session_country ORDER BY sessions DESC LIMIT 25 SINCE -30d UNTIL today`],
    ];

    // One bucket_start for the whole batch. Identifying a breakdown batch by
    // captured_at would collapse it to a single slice, because each row gets its
    // own now().
    const bucketStart = DateTime.utc().startOf('hour').toJSDate();
    let n = 0;
    for (const [schema, dim, q] of jobs) {
      const res = await this.shopify.source.shopifyql(q);
      const records = toRecords(res);
      for (const rec of records) {
        const label = rec[dim] ?? Object.values(rec)[0];
        if (label === undefined) continue;
        const metrics: Record<string, number> = {};
        for (const [k, v] of Object.entries(rec)) if (k !== dim) metrics[k] = num(v);
        await this.upsert(shop.id, schema, 'total', bucketStart, { [dim]: String(label) }, metrics, true);
        n++;
      }
    }
    this.log.log(`breakdown snapshots: ${n} rows`);
    return n;
  }

  private async upsertSeries(shop: Shop, schema: string, grain: 'day' | 'hour',
                             res: ShopifyQlResult, tsColumn: string) {
    const records = toRecords(res);
    if (!records.length) return 0;
    const nowUtc = DateTime.utc();
    let n = 0;

    for (const rec of records) {
      const raw = rec[tsColumn] ?? rec[Object.keys(rec)[0]];
      if (!raw) continue;

      // Day-grain values are shop-local dates; hour-grain values are UTC
      // instants. Normalise both to an absolute instant on ingestion so no
      // widget can ever mix a UTC hour with a Cairo day.
      const dt = grain === 'day'
        ? DateTime.fromISO(String(raw).slice(0, 10), { zone: shop.iana_timezone }).startOf('day')
        : DateTime.fromISO(String(raw), { zone: 'utc' });
      if (!dt.isValid) continue;

      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(rec)) if (k !== tsColumn) metrics[k] = num(v);

      // The current bucket is incomplete by definition. is_final is what lets
      // the interface label a provisional figure rather than presenting it as
      // settled -- and what lets the nightly job overwrite it later.
      const isFinal = grain === 'day'
        ? dt < nowUtc.setZone(shop.iana_timezone).startOf('day')
        : dt < nowUtc.startOf('hour');

      await this.upsert(shop.id, schema, grain, dt.toJSDate(), {}, metrics, isFinal);
      n++;
    }
    return n;
  }

  private async upsert(shopId: string, schema: string, grain: string, bucketStart: Date,
                       dimensions: Record<string, string>, metrics: Record<string, number>,
                       isFinal: boolean) {
    await query(
      `INSERT INTO sd_metric_snapshots
         (shop_id, schema_name, grain, bucket_start, bucket_timezone, dimensions, metrics, is_final, captured_at)
       VALUES ($1,$2,$3,$4,'Africa/Cairo',$5::jsonb,$6::jsonb,$7, now())
       ON CONFLICT ON CONSTRAINT sd_metric_snapshots_unique
       DO UPDATE SET metrics = EXCLUDED.metrics, is_final = EXCLUDED.is_final,
                     captured_at = now()`,
      [shopId, schema, grain, bucketStart, JSON.stringify(dimensions),
       JSON.stringify(metrics), isFinal],
    );
  }

  private async markSync(shopId: string, resource: string, records: number) {
    await query(
      `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records)
       VALUES ($1,$2, now(), now(), now(), 'OK', $3)
       ON CONFLICT (shop_id, resource) DO UPDATE
         SET watermark = now(), last_run_at = now(), last_ok_at = now(),
             status = 'OK', error = NULL, records = EXCLUDED.records`,
      [shopId, resource, records],
    );
  }

  /**
   * The capture a new order should trigger.
   *
   * This began as a narrow refresh -- seven days at day grain, forty-eight
   * hours at hour grain -- on the reasoning that an order changes today's
   * bucket and possibly yesterday's, never last March. The arithmetic was
   * right and the conclusion was wrong, because of how freshness is measured.
   *
   * The dashboard banner reports the age of the *oldest* figure on the page,
   * and every snapshot row carries its own `captured_at`. On a ninety-day view
   * that means rows eight to ninety keep whatever timestamp they were last
   * written with. Refreshing only the recent end left them untouched, so the
   * oldest figure stayed old and the banner never cleared -- no matter how many
   * times the recent end was refreshed.
   *
   * So this does what a manual capture does. It is more work than one order
   * strictly justifies, but "strictly justifies" was the reasoning that
   * produced a banner nobody could clear, and the cost is bounded: debounced to
   * one run per burst, a few ShopifyQL queries, well inside the rate limit.
   */
  private inFlight: Promise<number> | null = null;

  async refreshRecent(): Promise<number> {
    /* One capture at a time, process-wide.
     *
     * The guards on the scheduler are per-job, which is not the same thing.
     * Two different jobs -- the hourly capture and the refresh a reconciliation
     * asks for after it writes something -- both land here, and on a cold start
     * they landed within a second of each other. That is four ShopifyQL queries
     * over thirteen months at once, which emptied the cost bucket and produced
     * five THROTTLED responses and a failed job.
     *
     * A second caller joins the run already in progress rather than starting
     * another. It gets the same answer, which is correct: the two would have
     * queried the same range and written the same rows.
     */
    if (this.inFlight) {
      this.log.log('capture already running — joining it rather than starting a second');
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        const daily = await this.captureDaily();
        /* Fourteen days at hour grain, not three.
        
           Three was sized for the pulse strip, which only ever looks at today
           and yesterday. The day comparison reads hour grain for any date, and
           at three days almost every comparison fell through to a live Shopify
           call. Fourteen covers a fortnight of the comparisons people actually
           make -- this week against last -- for about 670 extra rows, which is
           nothing beside the 92,000-order mirror. */
        const hourly = await this.captureHourly(14);
        /* Breakdowns too, and leaving them out was the third time the same
           mistake was made in one build.
        
           Top products, traffic sources, device and country are their own rows
           in sd_metric_snapshots, and they feed real widgets. Refreshing only
           the time series left them holding whatever timestamp they were last
           written with -- and since the banner reports the age of the *oldest*
           figure on the page, a stale breakdown row kept it showing "5 hours
           ago" while eight hundred freshly captured rows sat beside it.
        
           The rule that keeps being relearned: a partial refresh cannot clear a
           whole-page freshness check. If the page reads it, this has to write
           it. */
        const breakdowns = await this.captureBreakdowns();
        return daily + hourly + breakdowns;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPending = false;

  /**
   * Ask for a refresh; get one shortly, once, however many times you ask.
   *
   * The delay is not only about batching. Shopify publishes no freshness
   * guarantee for analytics, and an order does not appear in ShopifyQL the
   * instant its webhook is delivered -- observation on this store puts the lag
   * under a minute, but it is a measurement, not a commitment. Capturing
   * immediately on delivery would reliably capture the figures from *before*
   * the order, write them as current, and look exactly like a bug.
   *
   * So: wait, then capture. And capture once more a few minutes later, because
   * a single miss would otherwise persist until the next scheduled run.
   */
  scheduleRefresh(delayMs = 45_000) {
    if (this.refreshPending) return;
    this.refreshPending = true;

    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      this.refreshPending = false;
      try {
        const n = await this.refreshRecent();
        this.log.log(`snapshot refresh after webhook: ${n} rows`);
      } catch (e: any) {
        this.log.error(`snapshot refresh failed: ${e?.message ?? e}`);
      }

      // The confirming pass. Cheap, and it is what stops a figure being wrong
      // for an hour because ShopifyQL was a minute behind the first attempt.
      setTimeout(() => {
        this.refreshRecent().catch((e) =>
          this.log.warn(`confirming snapshot refresh failed: ${e?.message ?? e}`));
      }, 4 * 60_000);
    }, delayMs);
  }

  /**
   * Fill in hour-grain history, once.
   *
   * The routine capture keeps a fortnight. This exists for the day a comparison
   * is wanted against something older -- a launch, last Ramadan, the same week
   * last year -- so those days are already in the store rather than costing a
   * live call the first time somebody looks.
   *
   * Run in monthly slices rather than as one query: a year of hourly buckets is
   * roughly 8,700 rows per schema, and asking ShopifyQL for all of it in one
   * request is exactly the shape of query that gets throttled.
   */
  async backfillHourly(months = 13): Promise<number> {
    const shop = await this.shops.get();
    const now = DateTime.now().setZone(shop.iana_timezone);
    let written = 0;

    for (let i = 0; i < months; i++) {
      const monthStart = now.minus({ months: i + 1 }).startOf('month');
      const monthEnd = monthStart.endOf('month');
      const since = monthStart.toFormat('yyyy-MM-dd');
      const until = monthEnd.toFormat('yyyy-MM-dd');

      for (const schema of ['sales', 'sessions'] as const) {
        const q = schema === 'sessions'
          ? `FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, ` +
            `sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate ` +
            `TIMESERIES hour SINCE ${since} UNTIL ${until} ` +
            `WHERE human_or_bot_session = 'human' ${this.tz(shop)}`
          : `FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, ` +
            `shipping_charges, taxes, total_sales, average_order_value ` +
            `TIMESERIES hour SINCE ${since} UNTIL ${until} ${this.tz(shop)}`;

        const res = await this.shopify.source.shopifyql(q);
        written += await this.upsertSeries(shop, schema, 'hour', res, 'hour');
      }
      this.log.log(`hourly backfill: ${since} done (${written} rows so far)`);
    }
    return written;
  }

  async captureAll() {
    const a = await this.captureDaily();
    const b = await this.captureHourly();
    const c = await this.captureBreakdowns();
    return { daily: a, hourly: b, breakdowns: c };
  }
}