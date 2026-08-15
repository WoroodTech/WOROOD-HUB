/**
 * Widget data.
 *
 * THE RULE, applied everywhere in this file:
 *   Aggregates come from the ShopifyQL snapshots. Individual records come from
 *   the order mirror. A headline figure is never computed by summing mirrored
 *   order rows when a snapshot metric exists for it.
 *
 * Recomputing "total sales" from orders means reimplementing Shopify's own
 * formula -- including its treatment of edits, partial refunds, duties and test
 * orders -- and being wrong in a way nobody can explain. The dashboard has to
 * reconcile with what finance sees in the Shopify admin, or it is worthless.
 *
 * Worood is a cash-on-delivery business: most live orders sit in PENDING with
 * net_payment at zero while total_price is large. That is not a bug, so two
 * figures are exposed and labelled distinctly -- sales (ordered, from the
 * snapshots) and collected (received, from the mirror). The gap between them is
 * money in transit with the couriers.
 */
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../../common/db';
import { Principal, can } from '../../../common/auth';
import { config } from '../../../common/config';
import { ShopContext, Shop } from '../analytics/snapshot.service';
import {
  CategoryPayload, FunnelPayload, KpiPayload, SeriesPayload, TablePayload,
  WidgetEnvelope, WidgetPayload, PERMISSIONS,
} from '../../../contract';

export type RangeKey = 'today' | '7d' | '30d' | '90d' | '13m';

export interface ResolvedRange {
  key: RangeKey; grain: 'hour' | 'day';
  start: Date; end: Date;
  priorStart: Date; priorEnd: Date;
  label: string; comparisonLabel: string;
}

/** All range arithmetic happens in the shop's timezone, never in UTC. */
export function resolveRange(key: RangeKey, tz: string, now = DateTime.now()): ResolvedRange {
  const nowTz = now.setZone(tz);
  const endOfToday = nowTz.endOf('day');
  const mk = (days: number, grain: 'hour' | 'day', label: string, cmp: string): ResolvedRange => {
    const start = nowTz.startOf('day').minus({ days: days - 1 });
    const priorStart = start.minus({ days });
    return {
      key, grain, start: start.toJSDate(), end: endOfToday.toJSDate(),
      priorStart: priorStart.toJSDate(), priorEnd: start.minus({ millisecond: 1 }).toJSDate(),
      label, comparisonLabel: cmp,
    };
  };
  switch (key) {
    case 'today': {
      const start = nowTz.startOf('day');
      return {
        key, grain: 'hour', start: start.toJSDate(), end: endOfToday.toJSDate(),
        priorStart: start.minus({ days: 1 }).toJSDate(),
        priorEnd: start.minus({ millisecond: 1 }).toJSDate(),
        label: 'Today', comparisonLabel: 'vs yesterday',
      };
    }
    case '7d':  return mk(7,  'day', 'Last 7 days',  'vs previous 7 days');
    case '90d': return mk(90, 'day', 'Last 90 days', 'vs previous 90 days');
    case '13m': return mk(395,'day', 'Last 13 months','vs previous 13 months');
    case '30d':
    default:    return mk(30, 'day', 'Last 30 days', 'vs previous 30 days');
  }
}

type Totals = Record<string, number>;

@Injectable()
export class MetricsService {
  constructor(private shops: ShopContext) {}

  /* ------------------------------------------------------- snapshot reads -- */

  private async totals(shop: Shop, schema: string, grain: 'hour' | 'day',
                       start: Date, end: Date): Promise<{ totals: Totals; capturedAt: Date | null; provisional: boolean }> {
    const rows = await query(
      `SELECT metrics, is_final, captured_at FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = $2 AND grain = $3
          AND bucket_start >= $4 AND bucket_start <= $5`,
      [shop.id, schema, grain, start, end],
    );
    const totals: Totals = {};
    let capturedAt: Date | null = null;
    let provisional = false;
    for (const r of rows) {
      if (!r.is_final) provisional = true;
      const c = new Date(r.captured_at);
      if (!capturedAt || c > capturedAt) capturedAt = c;
      for (const [k, v] of Object.entries(r.metrics as Record<string, number>)) {
        totals[k] = (totals[k] ?? 0) + Number(v ?? 0);
      }
    }
    return { totals, capturedAt, provisional };
  }

  private async series(shop: Shop, schema: string, grain: 'hour' | 'day',
                       start: Date, end: Date) {
    return query(
      `SELECT bucket_start, metrics, is_final, captured_at FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = $2 AND grain = $3
          AND bucket_start >= $4 AND bucket_start <= $5
        ORDER BY bucket_start ASC`,
      [shop.id, schema, grain, start, end],
    );
  }

  private async breakdown(shop: Shop, schema: string, dimension: string) {
    // Identified by the latest bucket_start, not by captured_at: each row gets
    // its own now(), so max(captured_at) would collapse a batch to one slice.
    const rows = await query(
      `SELECT dimensions, metrics, captured_at FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = $2 AND grain = 'total'
          AND dimensions ? $3
          AND bucket_start = (
            SELECT MAX(bucket_start) FROM sd_metric_snapshots
             WHERE shop_id = $1 AND schema_name = $2 AND grain = 'total' AND dimensions ? $3)`,
      [shop.id, schema, dimension],
    );
    return rows;
  }

  /* ------------------------------------------------------------- mirror -- */

  private async mirrorTotals(shop: Shop, start: Date, end: Date) {
    // Test orders are excluded from every aggregate; cancelled orders too,
    // except where a widget deliberately shows them.
    const rows = await query(
      `SELECT COALESCE(SUM(net_payment),0)      AS collected,
              COALESCE(SUM(total_outstanding),0) AS outstanding,
              COALESCE(SUM(total_price),0)       AS ordered,
              COUNT(*)                           AS orders
         FROM sd_orders
        WHERE shop_id = $1 AND test = false AND cancelled_at IS NULL
          AND shopify_created_at >= $2 AND shopify_created_at <= $3`,
      [shop.id, start, end],
    );
    return rows[0];
  }

  /* ------------------------------------------------------------ helpers -- */

  private kpi(label: string, value: number, format: KpiPayload['format'],
              prior: number | null, cmpLabel: string, currency?: string,
              provisional = false, sparkline?: number[]): KpiPayload {
    return { kind: 'kpi', label, value, format, currency,
             comparedTo: prior, comparisonLabel: cmpLabel, provisional, sparkline };
  }

  private async sparkline(shop: Shop, schema: string, metric: string): Promise<number[]> {
    const rows = await this.series(
      shop, schema, 'day',
      DateTime.now().setZone(shop.iana_timezone).startOf('day').minus({ days: 13 }).toJSDate(),
      DateTime.now().setZone(shop.iana_timezone).endOf('day').toJSDate(),
    );
    return rows.map((r) => Number((r.metrics as any)[metric] ?? 0));
  }

  /* ----------------------------------------------------------- widgets -- */

  async widget(widgetKey: string, rangeKey: RangeKey, principal: Principal): Promise<WidgetEnvelope> {
    const shop = await this.shops.get();
    const range = resolveRange(rangeKey, shop.iana_timezone);
    const generatedAt = new Date().toISOString();
    try {
      const { payload, capturedAt } = await this.build(widgetKey, shop, range, principal);
      return {
        widgetKey, title: widgetKey, generatedAt,
        dataAgeSeconds: capturedAt ? Math.round((Date.now() - capturedAt.getTime()) / 1000) : null,
        payload,
      };
    } catch (e: any) {
      // A widget that fails returns null with an error rather than failing the
      // whole dashboard -- one bad query must not blank the screen.
      return { widgetKey, title: widgetKey, generatedAt, dataAgeSeconds: null,
               payload: null, error: e?.message ?? 'Widget failed' };
    }
  }

  private async build(key: string, shop: Shop, range: ResolvedRange, principal: Principal):
      Promise<{ payload: WidgetPayload | null; capturedAt: Date | null }> {
    const cur = shop.currency_code;

    const salesNow  = () => this.totals(shop, 'sales', range.grain, range.start, range.end);
    const salesPrev = () => this.totals(shop, 'sales', range.grain, range.priorStart, range.priorEnd);
    const sessNow   = () => this.totals(shop, 'sessions', range.grain, range.start, range.end);
    const sessPrev  = () => this.totals(shop, 'sessions', range.grain, range.priorStart, range.priorEnd);

    switch (key) {
      /* ---- KPIs from the sales snapshots ---- */
      case 'kpi-total-sales': {
        const n = await salesNow(); const p = await salesPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Total sales', n.totals.total_sales ?? 0, 'money', p.totals.total_sales ?? null,
          range.comparisonLabel, cur, n.provisional, await this.sparkline(shop, 'sales', 'total_sales')) };
      }
      case 'kpi-gross-sales': {
        const n = await salesNow(); const p = await salesPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Gross sales', n.totals.gross_sales ?? 0, 'money', p.totals.gross_sales ?? null,
          range.comparisonLabel, cur, n.provisional) };
      }
      case 'kpi-net-sales': {
        const n = await salesNow(); const p = await salesPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Net sales', n.totals.net_sales ?? 0, 'money', p.totals.net_sales ?? null,
          range.comparisonLabel, cur, n.provisional) };
      }
      case 'kpi-discounts': {
        // ShopifyQL returns discounts NEGATIVE (net = gross + discounts). The
        // magnitude is shown here; the sign is preserved wherever it enters
        // arithmetic, so the two never disagree.
        const n = await salesNow(); const p = await salesPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Discounts', Math.abs(n.totals.discounts ?? 0), 'money',
          p.totals.discounts != null ? Math.abs(p.totals.discounts) : null,
          range.comparisonLabel, cur, n.provisional) };
      }
      case 'kpi-returns': {
        // Shopify documents net_sales = gross_sales - discounts - sales_reversals,
        // but this store's ShopifyQL sales schema does not expose a
        // sales_reversals column at all -- the live capture had to drop it.
        // Rather than leave the finance view unable to reconcile, the reversal
        // line is DERIVED from the identity Shopify itself publishes:
        //   reversals = (gross_sales + discounts) - net_sales
        // (discounts arrive negative, so the addition is the subtraction.)
        // If Shopify later exposes the column, prefer it and delete this.
        const n = await salesNow(); const p2 = await salesPrev();
        const derive = (t: Totals) =>
          Math.max(((t.gross_sales ?? 0) + (t.discounts ?? 0)) - (t.net_sales ?? 0), 0);
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Returns and reversals', derive(n.totals), 'money',
          p2.totals.gross_sales != null ? derive(p2.totals) : null,
          range.comparisonLabel, cur, n.provisional) };
      }
      case 'kpi-orders': {
        const n = await salesNow(); const p = await salesPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Orders', n.totals.orders ?? 0, 'integer', p.totals.orders ?? null,
          range.comparisonLabel, undefined, n.provisional,
          await this.sparkline(shop, 'sales', 'orders')) };
      }
      case 'kpi-aov': {
        // Shopify defines AOV as (gross_sales - discounts) / orders, computed
        // BEFORE post-order adjustments. Dividing total_sales by orders would
        // be close enough to look like a rounding bug and wrong enough to
        // matter, so it is re-derived rather than averaged over buckets.
        const n = await salesNow(); const p = await salesPrev();
        const aov = (t: Totals) => (t.orders ? ((t.gross_sales ?? 0) + (t.discounts ?? 0)) / t.orders : 0);
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Average order value', aov(n.totals), 'money',
          p.totals.orders ? aov(p.totals) : null, range.comparisonLabel, cur, n.provisional) };
      }

      /* ---- KPIs from the sessions snapshots ---- */
      case 'kpi-sessions': {
        const n = await sessNow(); const p = await sessPrev();
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Sessions', n.totals.sessions ?? 0, 'integer', p.totals.sessions ?? null,
          range.comparisonLabel, undefined, n.provisional,
          await this.sparkline(shop, 'sessions', 'sessions')) };
      }
      case 'kpi-conversion': {
        // conversion_rate is stored as the fraction Shopify returns
        // (0.0119 = 1.19%). It is multiplied by 100 exactly once, here, and the
        // client formats rather than converts.
        const n = await sessNow(); const p = await sessPrev();
        const rate = (t: Totals) => (t.sessions ? (t.sessions_that_completed_checkout ?? 0) / t.sessions * 100 : 0);
        return { capturedAt: n.capturedAt, payload: this.kpi(
          'Conversion rate', rate(n.totals), 'percent',
          p.totals.sessions ? rate(p.totals) : null, range.comparisonLabel,
          undefined, n.provisional) };
      }

      /* ---- KPIs from the order mirror (the cash-on-delivery pair) ---- */
      case 'kpi-collected': {
        const n = await this.mirrorTotals(shop, range.start, range.end);
        const p = await this.mirrorTotals(shop, range.priorStart, range.priorEnd);
        return { capturedAt: null, payload: this.kpi(
          'Collected', Number(n.collected), 'money', Number(p.collected), range.comparisonLabel, cur) };
      }
      case 'kpi-outstanding': {
        const n = await this.mirrorTotals(shop, range.start, range.end);
        const p = await this.mirrorTotals(shop, range.priorStart, range.priorEnd);
        return { capturedAt: null, payload: this.kpi(
          'Outstanding with couriers', Number(n.outstanding), 'money',
          Number(p.outstanding), range.comparisonLabel, cur) };
      }

      /* ---- series ---- */
      case 'chart-sales-trend': {
        const rows = await this.series(shop, 'sales', range.grain, range.start, range.end);
        return { capturedAt: this.latest(rows), payload: {
          kind: 'line', format: 'money', currency: cur, timezone: shop.iana_timezone,
          provisionalFrom: this.firstProvisional(rows),
          series: [
            { key: 'total_sales', label: 'Total sales',
              points: rows.map((r) => ({ t: new Date(r.bucket_start).toISOString(), v: Number((r.metrics as any).total_sales ?? 0) })) },
            { key: 'net_sales', label: 'Net sales',
              points: rows.map((r) => ({ t: new Date(r.bucket_start).toISOString(), v: Number((r.metrics as any).net_sales ?? 0) })) },
          ],
        } as SeriesPayload };
      }
      case 'chart-orders-trend': {
        const rows = await this.series(shop, 'sales', range.grain, range.start, range.end);
        return { capturedAt: this.latest(rows), payload: {
          kind: 'bar', format: 'integer', timezone: shop.iana_timezone,
          provisionalFrom: this.firstProvisional(rows),
          series: [{ key: 'orders', label: 'Orders',
            points: rows.map((r) => ({ t: new Date(r.bucket_start).toISOString(), v: Number((r.metrics as any).orders ?? 0) })) }],
        } as SeriesPayload };
      }
      case 'chart-sessions-trend': {
        const rows = await this.series(shop, 'sessions', range.grain, range.start, range.end);
        return { capturedAt: this.latest(rows), payload: {
          kind: 'line', format: 'integer', timezone: shop.iana_timezone,
          provisionalFrom: this.firstProvisional(rows),
          series: [
            { key: 'sessions', label: 'Sessions', format: 'integer',
              points: rows.map((r) => ({ t: new Date(r.bucket_start).toISOString(), v: Number((r.metrics as any).sessions ?? 0) })) },
            { key: 'conversion_rate', label: 'Conversion rate', format: 'percent',
              points: rows.map((r) => ({ t: new Date(r.bucket_start).toISOString(),
                v: Number((r.metrics as any).conversion_rate ?? 0) * 100 })) },
          ],
        } as SeriesPayload };
      }

      /* ---- breakdowns ---- */
      case 'donut-traffic-sources': {
        const rows = (await this.breakdown(shop, 'traffic', 'referrer_source'))
          .concat(await this.breakdown(shop, 'sessions', 'referrer_source'));
        return { capturedAt: this.latest(rows), payload: {
          kind: 'donut', format: 'integer',
          items: rows.map((r) => ({ label: (r.dimensions as any).referrer_source || 'direct',
                                    value: Number((r.metrics as any).sessions ?? 0) }))
                     .sort((a, b) => b.value - a.value),
        } as CategoryPayload };
      }
      case 'donut-devices': {
        const rows = await this.breakdown(shop, 'sessions', 'session_device_type');
        return { capturedAt: this.latest(rows), payload: {
          kind: 'donut', format: 'integer',
          items: rows.map((r) => ({ label: (r.dimensions as any).session_device_type || 'unknown',
                                    value: Number((r.metrics as any).sessions ?? 0) }))
                     .sort((a, b) => b.value - a.value),
        } as CategoryPayload };
      }
      case 'table-top-products': {
        const rows = await this.breakdown(shop, 'sales', 'product_title');
        const items = rows.map((r) => ({
          product: (r.dimensions as any).product_title,
          orders: Number((r.metrics as any).orders ?? 0),
          total_sales: Number((r.metrics as any).total_sales ?? 0),
        })).sort((a, b) => b.total_sales - a.total_sales).slice(0, 15);
        return { capturedAt: this.latest(rows), payload: {
          kind: 'table',
          columns: [
            { key: 'product', label: 'Product', format: 'text' },
            { key: 'orders', label: 'Orders', format: 'integer', align: 'end' },
            { key: 'total_sales', label: 'Total sales', format: 'money', align: 'end' },
          ],
          rows: items,
        } as TablePayload };
      }
      case 'table-top-countries': {
        const rows = await this.breakdown(shop, 'sessions', 'session_country');
        const items = rows.map((r) => ({
          country: (r.dimensions as any).session_country,
          sessions: Number((r.metrics as any).sessions ?? 0),
          conversion_rate: Number((r.metrics as any).conversion_rate ?? 0) * 100,
        })).sort((a, b) => b.sessions - a.sessions).slice(0, 15);
        return { capturedAt: this.latest(rows), payload: {
          kind: 'table',
          columns: [
            { key: 'country', label: 'Country', format: 'text' },
            { key: 'sessions', label: 'Sessions', format: 'integer', align: 'end' },
            { key: 'conversion_rate', label: 'Conversion', format: 'percent', align: 'end' },
          ],
          rows: items,
        } as TablePayload };
      }
      case 'funnel-conversion': {
        const n = await sessNow();
        return { capturedAt: n.capturedAt, payload: {
          kind: 'funnel',
          steps: [
            { label: 'Sessions', value: n.totals.sessions ?? 0 },
            { label: 'Added to cart', value: n.totals.sessions_with_cart_additions ?? 0 },
            { label: 'Reached checkout', value: n.totals.sessions_that_reached_checkout ?? 0 },
            { label: 'Completed checkout', value: n.totals.sessions_that_completed_checkout ?? 0 },
          ],
        } as FunnelPayload };
      }

      /* ---- from the mirror ---- */
      case 'table-recent-orders': {
        const showCustomer = can(principal, PERMISSIONS.CUSTOMER_VIEW);
        const rows = await query(
          `SELECT o.name, o.shopify_created_at, o.financial_status, o.fulfillment_status,
                  o.total_price, o.net_payment, c.display_name, o.ship_city
             FROM sd_orders o LEFT JOIN sd_customers c ON c.id = o.customer_id
            WHERE o.shop_id = $1 AND o.test = false
            ORDER BY o.shopify_created_at DESC LIMIT 15`, [shop.id]);
        const columns: TablePayload['columns'] = [
          { key: 'name', label: 'Order', format: 'text' },
          { key: 'createdAt', label: 'Placed', format: 'datetime' },
          ...(showCustomer ? [
            { key: 'customer', label: 'Customer', format: 'text' as const },
            { key: 'city', label: 'City', format: 'text' as const },
          ] : []),
          { key: 'status', label: 'Payment', format: 'status' },
          { key: 'total', label: 'Ordered', format: 'money', align: 'end' },
          { key: 'collected', label: 'Collected', format: 'money', align: 'end' },
        ];
        return { capturedAt: null, payload: {
          kind: 'table', columns,
          rows: rows.map((r) => ({
            name: r.name,
            createdAt: new Date(r.shopify_created_at).toISOString(),
            // Withheld fields are ABSENT from the object, not blanked, so the
            // client cannot reveal them by inspecting the response.
            ...(showCustomer ? { customer: r.display_name, city: r.ship_city } : {}),
            status: r.financial_status,
            total: Number(r.total_price),
            collected: Number(r.net_payment),
          })),
          redactedColumns: showCustomer ? undefined : ['customer', 'city'],
        } as TablePayload };
      }

      default:
        return { capturedAt: null, payload: null };
    }
  }

  private latest(rows: any[]): Date | null {
    let out: Date | null = null;
    for (const r of rows) {
      const c = new Date(r.captured_at);
      if (!out || c > out) out = c;
    }
    return out;
  }

  private firstProvisional(rows: any[]): string | null {
    const r = rows.find((x) => !x.is_final);
    return r ? new Date(r.bucket_start).toISOString() : null;
  }

  /* -------------------------------------------------------- store pulse -- */

  /**
   * The most recent business day that actually has snapshot data.
   *
   * "Today" is the honest default, but early in the Cairo day -- or whenever a
   * capture has not run yet -- today's buckets do not exist, and a strip of
   * zeros reads as a broken dashboard rather than as an empty morning. The
   * portlet therefore reports the latest day it has, and says which day that is
   * through businessDate and dataAgeSeconds. Showing a real figure and naming
   * its date is more truthful than showing a zero that looks like a fact.
   */
  private async latestBusinessDay(shop: Shop): Promise<DateTime> {
    const row = await query(
      `SELECT MAX(bucket_start) AS latest FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = 'sales' AND grain = 'hour'`, [shop.id]);
    const latest = row[0]?.latest ? DateTime.fromJSDate(new Date(row[0].latest)) : null;
    const today = DateTime.now().setZone(shop.iana_timezone).startOf('day');
    if (!latest) return today;
    const latestDay = latest.setZone(shop.iana_timezone).startOf('day');
    return latestDay > today ? today : latestDay;
  }

  async pulse(_principal: Principal) {
    const shop = await this.shops.get();
    const day = await this.latestBusinessDay(shop);
    const range: ResolvedRange = {
      key: 'today', grain: 'hour',
      start: day.toJSDate(), end: day.endOf('day').toJSDate(),
      priorStart: day.minus({ days: 1 }).toJSDate(),
      priorEnd: day.minus({ millisecond: 1 }).toJSDate(),
      label: 'Latest business day', comparisonLabel: 'vs previous day',
    };
    const sales = await this.totals(shop, 'sales', 'hour', range.start, range.end);
    const salesPrev = await this.totals(shop, 'sales', 'hour', range.priorStart, range.priorEnd);
    const sess = await this.totals(shop, 'sessions', 'hour', range.start, range.end);
    const sessPrev = await this.totals(shop, 'sessions', 'hour', range.priorStart, range.priorEnd);
    const mirror = await this.mirrorTotals(shop, range.start, range.end);
    const mirrorPrev = await this.mirrorTotals(shop, range.priorStart, range.priorEnd);

    const rate = (t: Totals) => (t.sessions ? (t.sessions_that_completed_checkout ?? 0) / t.sessions * 100 : 0);

    return {
      shopName: shop.name, currency: shop.currency_code, timezone: shop.iana_timezone,
      businessDate: DateTime.fromJSDate(range.start).setZone(shop.iana_timezone).toISODate(),
      provisional: sales.provisional || sess.provisional,
      dataAgeSeconds: sales.capturedAt
        ? Math.round((Date.now() - sales.capturedAt.getTime()) / 1000) : null,
      metrics: [
        { key: 'total_sales', label: 'Sales', value: sales.totals.total_sales ?? 0,
          format: 'money', comparedTo: salesPrev.totals.total_sales ?? null, comparisonLabel: range.comparisonLabel },
        { key: 'orders', label: 'Orders', value: sales.totals.orders ?? 0,
          format: 'integer', comparedTo: salesPrev.totals.orders ?? null, comparisonLabel: range.comparisonLabel },
        { key: 'collected', label: 'Collected', value: Number(mirror.collected),
          format: 'money', comparedTo: Number(mirrorPrev.collected), comparisonLabel: range.comparisonLabel },
        { key: 'sessions', label: 'Sessions', value: sess.totals.sessions ?? 0,
          format: 'integer', comparedTo: sessPrev.totals.sessions ?? null, comparisonLabel: range.comparisonLabel },
        { key: 'conversion_rate', label: 'Conversion', value: rate(sess.totals),
          format: 'percent', comparedTo: sessPrev.totals.sessions ? rate(sessPrev.totals) : null,
          comparisonLabel: range.comparisonLabel },
      ],
    };
  }

  get staleAfterMinutes() { return config.sync.staleAfterMinutes; }
}
