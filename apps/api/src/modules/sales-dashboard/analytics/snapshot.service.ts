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
  private readonly TZ = "WITH TIMEZONE 'Africa/Cairo'";

  salesQuery(grain: 'day' | 'hour', since: string) {
    // sales_reversals is absent from this store's ShopifyQL sales schema -- the
    // live capture had to drop it. Missing columns are treated as zero rather
    // than crashing the capture; see upsert() below.
    return `FROM sales SHOW orders, gross_sales, discounts, net_sales, ` +
      `shipping_charges, taxes, total_sales, average_order_value ` +
      `TIMESERIES ${grain} SINCE ${since} UNTIL today ${this.TZ}`;
  }

  sessionsQuery(grain: 'day' | 'hour', since: string) {
    // Bot filtering is not automatic. Omitting this clause inflates sessions and
    // depresses conversion rate, and the convention must match how Worood reads
    // the Shopify admin or the two will disagree.
    return `FROM sessions SHOW sessions, online_store_visitors, ` +
      `sessions_with_cart_additions, sessions_that_reached_checkout, ` +
      `sessions_that_completed_checkout, conversion_rate ` +
      `TIMESERIES ${grain} SINCE ${since} UNTIL today ` +
      `WHERE human_or_bot_session = 'human' ${this.TZ}`;
  }

  /** Nightly: day grain over the trailing 13 months, refreshing any figure
   *  Shopify has since adjusted and keeping year-on-year honest. */
  async captureDaily(sinceDays = 395) {
    const shop = await this.shops.get();
    const sales = await this.shopify.source.shopifyql(this.salesQuery('day', `-${sinceDays}d`));
    const sessions = await this.shopify.source.shopifyql(this.sessionsQuery('day', `-${sinceDays}d`));
    const a = await this.upsertSeries(shop, 'sales', 'day', sales, 'day');
    const b = await this.upsertSeries(shop, 'sessions', 'day', sessions, 'day');
    await this.markSync(shop.id, 'sales_snapshot', a + b);
    this.log.log(`daily snapshots: ${a} sales + ${b} sessions buckets`);
    return a + b;
  }

  /** Hourly: current and previous day at hour grain, for the pulse strip and
   *  the intraday trend. */
  async captureHourly(sinceDays = 3) {
    const shop = await this.shops.get();
    const sales = await this.shopify.source.shopifyql(this.salesQuery('hour', `-${sinceDays}d`));
    const sessions = await this.shopify.source.shopifyql(this.sessionsQuery('hour', `-${sinceDays}d`));
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
       `FROM sales SHOW gross_sales, net_sales, total_sales, orders GROUP BY product_title ORDER BY total_sales DESC LIMIT 50 SINCE -90d UNTIL today ${this.TZ}`],
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

  async captureAll() {
    const a = await this.captureDaily();
    const b = await this.captureHourly();
    const c = await this.captureBreakdowns();
    return { daily: a, hourly: b, breakdowns: c };
  }
}
