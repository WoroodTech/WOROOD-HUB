/**
 * Customer analytics, computed from the mirror.
 *
 * Everything else in this module obeys one rule: aggregates come from
 * ShopifyQL, records come from the Admin API, and a dashboard figure is never
 * computed by summing mirrored order rows. That rule exists so the sales
 * figures reconcile exactly with the Shopify admin.
 *
 * These do not, and cannot. Cohort retention, repeat-purchase rate and RFM
 * segmentation have no ShopifyQL metric to read -- Shopify's own customer
 * reports compute them internally and do not expose them through
 * `shopifyqlQuery`. So they are computed here, from 92,000 mirrored orders and
 * their customer links, which is the only place the raw material exists.
 *
 * That is a deliberate exception and it comes with an obligation: every widget
 * in this file carries `computedLocally: true`, and the interface says so. A
 * figure that cannot be checked against the admin must not look like one that
 * can. Small differences from Shopify's own customer reports are expected --
 * theirs count test orders and cancellations differently, and the exclusions
 * below are ours.
 *
 * Exclusions applied everywhere here: `test = false`, `cancelled_at IS NULL`,
 * `deleted_at IS NULL`, and a non-null `customer_id`. Guest orders with no
 * customer record cannot participate in a customer metric -- counting them as
 * one-time buyers would inflate the new-customer share by however many people
 * checked out without an account.
 */
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { query } from '../../../common/db';
import type { Shop } from '../analytics/snapshot.service';
import type { ResolvedRange } from './metrics.service';

/** The shared WHERE every query below starts from. Written once because a
 *  metric that silently includes cancelled orders while its neighbour excludes
 *  them is the kind of inconsistency nobody finds until someone adds up two
 *  widgets and gets a third number. */
const LIVE_ORDER = `
  o.test = false AND o.cancelled_at IS NULL AND o.deleted_at IS NULL
  AND o.customer_id IS NOT NULL`;

/** Customers removed in Shopify stop counting. Every figure here is a ratio
 *  over the customer base, so leaving them in skews all of them -- and a
 *  deleted person should not still be named in the top-customers table. */
const LIVE_CUSTOMER = `c.deleted_at IS NULL`;

export interface CohortRow {
  cohort: string;
  customers: number;
  /** Share of the cohort that had bought again by month N. Cumulative. */
  m1: number; m3: number; m6: number; m12: number;
}

@Injectable()
export class CustomerMetricsService {

  /* ------------------------------------------------------- new vs returning -- */

  /**
   * An order is "returning" when its customer had bought before *that order*,
   * not before the range.
   *
   * The distinction matters and is easy to get wrong. Counting by
   * `orders_count > 1` on the customer row asks "has this person ever bought
   * more than once", which reclassifies history: a customer who bought once in
   * January and again in March turns January's order into a returning one the
   * moment March happens. Comparing against the customer's own first order date
   * keeps each order classified as it was at the time.
   */
  async newVsReturning(shop: Shop, start: Date, end: Date) {
    const [row] = await query<{ new_orders: string; returning_orders: string;
                                new_revenue: string; returning_revenue: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE o.shopify_created_at <= c.first_order_at)         AS new_orders,
         COUNT(*) FILTER (WHERE o.shopify_created_at >  c.first_order_at)         AS returning_orders,
         COALESCE(SUM(o.total_price) FILTER (WHERE o.shopify_created_at <= c.first_order_at), 0) AS new_revenue,
         COALESCE(SUM(o.total_price) FILTER (WHERE o.shopify_created_at >  c.first_order_at), 0) AS returning_revenue
       FROM sd_orders o
       JOIN sd_customers c ON c.id = o.customer_id
      WHERE o.shop_id = $1 AND ${LIVE_ORDER} AND ${LIVE_CUSTOMER}
        AND o.shopify_created_at >= $2 AND o.shopify_created_at <= $3`,
      [shop.id, start, end]);

    return {
      newOrders: Number(row?.new_orders ?? 0),
      returningOrders: Number(row?.returning_orders ?? 0),
      newRevenue: Number(row?.new_revenue ?? 0),
      returningRevenue: Number(row?.returning_revenue ?? 0),
    };
  }

  /* --------------------------------------------------- repeat purchase rate -- */

  /**
   * Of the customers who bought in this range, what share have ever bought more
   * than once.
   *
   * Deliberately measured over the customer's whole history rather than within
   * the range: a customer who bought in January and returned in June is a
   * repeat customer, and asking whether they repeated *inside March* would say
   * no for a reason that has nothing to do with them.
   */
  async repeatRate(shop: Shop, start: Date, end: Date) {
    const [row] = await query<{ customers: string; repeat_customers: string }>(
      `SELECT COUNT(DISTINCT c.id)                                        AS customers,
              COUNT(DISTINCT c.id) FILTER (WHERE c.orders_count > 1)      AS repeat_customers
         FROM sd_orders o
         JOIN sd_customers c ON c.id = o.customer_id
        WHERE o.shop_id = $1 AND ${LIVE_ORDER} AND ${LIVE_CUSTOMER}
          AND o.shopify_created_at >= $2 AND o.shopify_created_at <= $3`,
      [shop.id, start, end]);

    const customers = Number(row?.customers ?? 0);
    const repeat = Number(row?.repeat_customers ?? 0);
    return { customers, repeat, rate: customers ? repeat / customers : 0 };
  }

  /* ---------------------------------------------------------------- cohorts -- */

  /**
   * Monthly acquisition cohorts, and how much of each came back.
   *
   * Rows are customers grouped by the month of their first order; columns are
   * the share who had ordered again within one, three, six and twelve months.
   * Cumulative, not incremental -- "came back by month 6" includes anyone who
   * came back in month 1.
   *
   * Young cohorts are excluded from the later columns rather than shown as
   * zero. A cohort acquired last month has had no opportunity to return within
   * twelve, and printing 0% next to it would read as catastrophic retention
   * rather than as an absent measurement. This is the single most common way a
   * cohort table lies.
   */
  async cohorts(shop: Shop, months = 12): Promise<CohortRow[]> {
    const rows = await query<any>(
      `WITH first_orders AS (
         SELECT c.id,
                date_trunc('month', c.first_order_at AT TIME ZONE $2) AS cohort,
                c.first_order_at
           FROM sd_customers c
          WHERE c.shop_id = $1 AND c.deleted_at IS NULL AND c.first_order_at IS NOT NULL
            AND c.first_order_at >= now() - ($3 || ' months')::interval
       ),
       repeats AS (
         SELECT f.id, f.cohort,
                MIN(o.shopify_created_at) FILTER (
                  WHERE o.shopify_created_at > f.first_order_at) AS second_at,
                f.first_order_at
           FROM first_orders f
           JOIN sd_orders o ON o.customer_id = f.id
          WHERE ${LIVE_ORDER} AND o.shop_id = $1
          GROUP BY f.id, f.cohort, f.first_order_at
       )
       SELECT to_char(cohort, 'YYYY-MM') AS cohort,
              COUNT(*)                                                       AS customers,
              COUNT(*) FILTER (WHERE second_at <= first_order_at + interval '1 month')  AS m1,
              COUNT(*) FILTER (WHERE second_at <= first_order_at + interval '3 months') AS m3,
              COUNT(*) FILTER (WHERE second_at <= first_order_at + interval '6 months') AS m6,
              COUNT(*) FILTER (WHERE second_at <= first_order_at + interval '12 months') AS m12,
              MIN(first_order_at) AS cohort_start
         FROM repeats
        GROUP BY cohort
        ORDER BY cohort DESC`,
      [shop.id, shop.iana_timezone, String(months)]);

    const now = DateTime.now();
    return rows.map((r) => {
      const ageMonths = now.diff(DateTime.fromJSDate(new Date(r.cohort_start)), 'months').months;
      const n = Number(r.customers) || 1;
      // Null, not zero, where the window has not elapsed yet.
      const at = (v: any, needed: number) => (ageMonths >= needed ? Number(v) / n : null);
      return {
        cohort: r.cohort,
        customers: Number(r.customers),
        m1: at(r.m1, 1) as number,
        m3: at(r.m3, 3) as number,
        m6: at(r.m6, 6) as number,
        m12: at(r.m12, 12) as number,
      };
    });
  }

  /* ----------------------------------------------------------- segmentation -- */

  /**
   * RFM-style segments, in the vocabulary a customer-care team already uses.
   *
   * Boundaries are round numbers rather than percentile splits, deliberately.
   * A percentile segment renames itself every time the underlying distribution
   * shifts, so "at risk" means something different this month from last and
   * nobody can act on it. A customer who has not ordered in 180 days is at risk
   * in January and in June alike.
   */
  async segments(shop: Shop) {
    const rows = await query<{ segment: string; customers: string; value: string }>(
      `WITH scored AS (
         SELECT c.id,
                c.orders_count,
                c.total_spent,
                EXTRACT(DAY FROM now() - c.last_order_at) AS days_since
           FROM sd_customers c
          WHERE c.shop_id = $1 AND c.deleted_at IS NULL
            AND c.last_order_at IS NOT NULL AND c.orders_count > 0
       )
       SELECT CASE
                WHEN days_since <= 90  AND orders_count >= 3 THEN 'Champions'
                WHEN days_since <= 90  AND orders_count = 2  THEN 'Growing'
                WHEN days_since <= 90  AND orders_count = 1  THEN 'New'
                WHEN days_since <= 180 AND orders_count >= 2 THEN 'Cooling'
                WHEN days_since <= 365                       THEN 'At risk'
                ELSE 'Lapsed'
              END AS segment,
              COUNT(*)              AS customers,
              COALESCE(SUM(total_spent), 0) AS value
         FROM scored
        GROUP BY 1`,
      [shop.id]);

    /* A fixed order, so the chart does not reshuffle itself between loads and
       reads as movement that did not happen. */
    const ORDER = ['Champions', 'Growing', 'New', 'Cooling', 'At risk', 'Lapsed'];
    return rows
      .map((r) => ({ segment: r.segment, customers: Number(r.customers), value: Number(r.value) }))
      .sort((a, b) => ORDER.indexOf(a.segment) - ORDER.indexOf(b.segment));
  }

  /* -------------------------------------------------------------- lifecycle -- */

  /** Median days between a customer's first and second order, and the
   *  distribution of how many orders customers place. Both answer "what does a
   *  Worood customer actually do" better than any single average. */
  async lifecycle(shop: Shop) {
    const [timing] = await query<{ median_days: string; second_order_customers: string }>(
      `WITH pairs AS (
         SELECT c.id, c.first_order_at,
                MIN(o.shopify_created_at) FILTER (
                  WHERE o.shopify_created_at > c.first_order_at) AS second_at
           FROM sd_customers c
           JOIN sd_orders o ON o.customer_id = c.id
          WHERE c.shop_id = $1 AND c.deleted_at IS NULL AND ${LIVE_ORDER} AND o.shop_id = $1
          GROUP BY c.id, c.first_order_at
       )
       SELECT COUNT(*) FILTER (WHERE second_at IS NOT NULL) AS second_order_customers,
              COALESCE(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (second_at - first_order_at)) / 86400
              ) FILTER (WHERE second_at IS NOT NULL), 0) AS median_days
         FROM pairs`,
      [shop.id]);

    const buckets = await query<{ bucket: string; customers: string }>(
      `SELECT CASE
                WHEN orders_count = 1 THEN '1 order'
                WHEN orders_count = 2 THEN '2 orders'
                WHEN orders_count BETWEEN 3 AND 5 THEN '3–5 orders'
                WHEN orders_count BETWEEN 6 AND 10 THEN '6–10 orders'
                ELSE '11+ orders'
              END AS bucket,
              COUNT(*) AS customers
         FROM sd_customers
        WHERE shop_id = $1 AND deleted_at IS NULL AND orders_count > 0
        GROUP BY 1`,
      [shop.id]);

    const ORDER = ['1 order', '2 orders', '3–5 orders', '6–10 orders', '11+ orders'];
    return {
      medianDaysToSecond: Math.round(Number(timing?.median_days ?? 0)),
      secondOrderCustomers: Number(timing?.second_order_customers ?? 0),
      buckets: buckets
        .map((b) => ({ label: b.bucket, value: Number(b.customers) }))
        .sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label)),
    };
  }

  /* ------------------------------------------------------------- acquisition -- */

  /** New customers per bucket, against orders from customers acquired earlier.
   *  The two lines together are the acquisition-versus-retention picture. */
  async acquisitionSeries(shop: Shop, range: ResolvedRange) {
    const unit = range.grain === 'hour' ? 'hour' : 'day';
    return query<{ bucket: Date; new_customers: string; returning_orders: string }>(
      `SELECT date_trunc($4, o.shopify_created_at AT TIME ZONE $5) AS bucket,
              COUNT(DISTINCT c.id) FILTER (WHERE o.shopify_created_at <= c.first_order_at) AS new_customers,
              COUNT(*)             FILTER (WHERE o.shopify_created_at >  c.first_order_at) AS returning_orders
         FROM sd_orders o
         JOIN sd_customers c ON c.id = o.customer_id
        WHERE o.shop_id = $1 AND ${LIVE_ORDER} AND ${LIVE_CUSTOMER}
          AND o.shopify_created_at >= $2 AND o.shopify_created_at <= $3
        GROUP BY 1 ORDER BY 1`,
      [shop.id, range.start, range.end, unit, shop.iana_timezone]);
  }

  /* --------------------------------------------------------------- top buyers -- */

  /**
   * The customers worth knowing by name. Requires `sales.customer.view`; the
   * caller passes `showIdentity` and the identifying columns are omitted from
   * the response rather than blanked in the browser, so a client cannot reveal
   * them by inspecting the payload.
   */
  async topCustomers(shop: Shop, showIdentity: boolean, limit = 15) {
    const rows = await query<any>(
      `SELECT c.display_name, c.email, c.address_city,
              c.orders_count, c.total_spent, c.last_order_at
         FROM sd_customers c
        WHERE c.shop_id = $1 AND c.deleted_at IS NULL AND c.orders_count > 0
        ORDER BY c.total_spent DESC NULLS LAST
        LIMIT $2`,
      [shop.id, limit]);

    return rows.map((r, i) => ({
      rank: i + 1,
      ...(showIdentity
        ? { customer: r.display_name ?? '—', city: r.address_city ?? '—' }
        : {}),
      orders: Number(r.orders_count ?? 0),
      spent: Number(r.total_spent ?? 0),
      lastOrder: r.last_order_at,
    }));
  }
}