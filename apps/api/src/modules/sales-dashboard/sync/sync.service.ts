/**
 * Reconciliation, the subscription watchdog, retention, and the health screen.
 *
 * Webhooks make the dashboard feel live; reconciliation makes it true. Shopify
 * states plainly that webhook delivery is not guaranteed, so the scheduled pull
 * is the source of truth and the fifteen-minute cadence is the practical upper
 * bound on how long a missed webhook can go unnoticed.
 */
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Param, Post, Query } from '@nestjs/common';
import { config } from '../../../common/config';
import { DateTime } from 'luxon';
import { query, one } from '../../../common/db';
import { Permissions } from '../../../common/auth';
import { NotificationsService } from '../../../core/core.module';
import { ShopContext } from '../analytics/snapshot.service';
import { SnapshotService } from '../analytics/snapshot.service';
import { ShopifyService, redis } from '../shopify/shopify.service';
import { WEBHOOK_TOPICS } from '../webhooks/topics';
import { BackfillService } from './backfill.service';
import { AbandonedCheckoutService } from './abandoned-checkout.service';
import { StoreCreditService } from './store-credit.service';
import { PERMISSIONS, SyncHealthResponse } from '../../../contract';

const money = (v: any) => (v == null ? 0 : parseFloat(String(v)));
const shopMoney = (bag: any) => money(bag?.shopMoney?.amount);

@Injectable()
export class SyncService {
  private readonly log = new Logger('SyncService');

  constructor(
    private shops: ShopContext,
    private shopify: ShopifyService,
    private snapshots: SnapshotService,
    private notifications: NotificationsService,
    private backfills: BackfillService,
  ) {}

  /** Upsert path shared by the backfill and by reconciliation, so an order
   *  written by either takes exactly the same route into the mirror. */
  async upsertOrders(orders: any[]): Promise<number> {
    const shop = await this.shops.get();
    let n = 0;
    /* Collected as we go and recomputed once at the end. Lifetime spend depends
       on the orders written in this batch, so it cannot be part of the customer
       upsert above -- the orders do not exist yet at that point. */
    const touchedCustomers = new Set<string>();

    for (const o of orders) {
      const updatedAt = new Date(o.updatedAt ?? o.createdAt);
      const existing = await one(
        `SELECT shopify_updated_at FROM sd_orders WHERE shopify_gid = $1`, [o.id]);
      // The ordering guard, applied identically here and in the webhook path.
      if (existing && new Date(existing.shopify_updated_at) > updatedAt) continue;

      let customerId: string | null = null;
      if (o.customer?.id) {
        const c = await one(
          `INSERT INTO sd_customers (shop_id, shopify_gid, orders_count, display_name,
              email, phone, address_city, address_province, address_country,
              shopify_created_at, shopify_updated_at, last_order_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
           -- Identity only on conflict. orders_count is seeded on insert so a
           -- new customer is not zero for an instant, and is never updated from
           -- Shopify afterwards: it counts on Shopify's basis, while every
           -- figure here excludes test, cancelled and deleted orders. Two
           -- sources for one column means whichever wrote last wins, and on a
           -- cancellation that is the wrong one. refreshCustomerSpend recomputes
           -- it, first_order_at and last_order_at from our own orders at the end
           -- of the batch.
           ON CONFLICT (shopify_gid) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             email = EXCLUDED.email, phone = EXCLUDED.phone
           RETURNING id`,
          [shop.id, o.customer.id, o.customer.numberOfOrders ?? 0,
           o.customer.displayName ?? null, o.customer.email ?? null, o.customer.phone ?? null,
           o.shippingAddress?.city ?? null, o.shippingAddress?.province ?? null,
           o.shippingAddress?.country ?? null, o.customer.createdAt ?? null,
           new Date(o.createdAt)]);
        customerId = c.id;
        touchedCustomers.add(c.id);
      }

      const row = await one(
        `INSERT INTO sd_orders (shop_id, shopify_gid, name, order_number, customer_id,
            shopify_created_at, processed_at, cancelled_at, cancel_reason, shopify_updated_at,
            test, financial_status, fulfillment_status, source_name, tags,
            currency_code, presentment_currency_code,
            total_price, current_total_price, subtotal_price, current_subtotal_price,
            total_discounts, total_tax, total_shipping, total_refunded, net_payment,
            total_outstanding, presentment_total_price,
            ship_city, ship_province, ship_country)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
         ON CONFLICT (shopify_gid) DO UPDATE SET
           -- Never null an existing customer link.
           --
           -- Not every source of an order carries the customer. The webhook
           -- payload does; the hydration read deliberately does not, because
           -- asking for protected customer fields risks the whole query being
           -- denied and losing the line items with it. Written as plain
           -- EXCLUDED.customer_id, the hydration that runs seconds after a
           -- webhook erased the name the webhook had just stored: a customer
           -- that appeared and then turned into a dash, most often after a
           -- refund, which triggers an extra orders/updated.
           --
           -- COALESCE makes the write additive. A source that knows the
           -- customer sets it; a source that does not leaves it alone. The
           -- link is only ever cleared deliberately, by the retention job.
           customer_id = COALESCE(EXCLUDED.customer_id, sd_orders.customer_id),
           cancelled_at = EXCLUDED.cancelled_at, cancel_reason = EXCLUDED.cancel_reason,
           shopify_updated_at = EXCLUDED.shopify_updated_at,
           financial_status = EXCLUDED.financial_status,
           fulfillment_status = EXCLUDED.fulfillment_status,
           total_price = EXCLUDED.total_price,
           current_total_price = EXCLUDED.current_total_price,
           total_refunded = EXCLUDED.total_refunded,
           net_payment = EXCLUDED.net_payment,
           total_outstanding = EXCLUDED.total_outstanding
         RETURNING id, customer_id`,
        [shop.id, o.id, o.name, orderNumber(o.name),
         customerId, new Date(o.createdAt), o.processedAt ?? null,
         o.cancelledAt ?? null, o.cancelReason ?? null, updatedAt,
         !!o.test, o.displayFinancialStatus ?? null, o.displayFulfillmentStatus ?? null,
         o.sourceName ?? null, o.tags ?? [],
         o.currencyCode ?? shop.currency_code, o.presentmentCurrencyCode ?? null,
         shopMoney(o.totalPriceSet), shopMoney(o.currentTotalPriceSet),
         shopMoney(o.subtotalPriceSet), shopMoney(o.currentSubtotalPriceSet),
         shopMoney(o.totalDiscountsSet), shopMoney(o.totalTaxSet),
         shopMoney(o.totalShippingPriceSet), shopMoney(o.totalRefundedSet),
         shopMoney(o.netPaymentSet), shopMoney(o.totalOutstandingSet),
         money(o.totalPriceSet?.presentmentMoney?.amount),
         o.shippingAddress?.city ?? null, o.shippingAddress?.province ?? null,
         o.shippingAddress?.country ?? null]);

      /* The order's customer, whether or not this payload carried one.
       *
       * `hydrate` deliberately omits the customer fields to avoid the
       * protected-data denial that already affects the backfill, so `o.customer`
       * is undefined on the webhook path and the block above never ran. The set
       * stayed empty, `refreshCustomerSpend` did nothing, and every customer
       * statistic waited for the fifteen-minute reconciliation -- or forever, if
       * hydration had failed, since it is best-effort by design.
       *
       * Reading the link back off the row covers both cases: a payload that
       * brought the customer, and one that merely updated an order already
       * attached to one. */
      if (row?.customer_id) touchedCustomers.add(row.customer_id);

      /* Line items are corrected and pruned, not merely inserted.
       *
       * `ON CONFLICT DO NOTHING` was wrong twice over. An order edited in
       * Shopify -- a quantity changed, a line discounted -- kept its original
       * figures here forever, because the conflicting insert did nothing. And a
       * line *removed* from an order stayed in the mirror indefinitely, since
       * nothing ever deleted. Order edits are ordinary on a florist's orders,
       * where a customer rings to change an arrangement.
       *
       * Only touched when the payload actually carries line items. The webhook
       * path and the hydration read both include them, but a payload that
       * happened not to would otherwise delete every line on the order. */
      if (o.lineItems?.nodes?.length) {
        const seen: string[] = [];
        for (const li of o.lineItems.nodes) {
          seen.push(li.id);
          await query(
            `INSERT INTO sd_order_line_items (order_id, shopify_gid, product_gid, variant_gid,
                title, variant_title, sku, quantity, current_quantity, original_total, discounted_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (shopify_gid) DO UPDATE SET
               quantity = EXCLUDED.quantity,
               current_quantity = EXCLUDED.current_quantity,
               original_total = EXCLUDED.original_total,
               discounted_total = EXCLUDED.discounted_total,
               title = EXCLUDED.title, variant_title = EXCLUDED.variant_title`,
            [row.id, li.id, li.product?.id ?? null, li.variant?.id ?? null,
             li.title, li.variant?.title ?? null, li.sku ?? null,
             li.quantity ?? 0, li.currentQuantity ?? li.quantity ?? 0,
             shopMoney(li.originalTotalSet), shopMoney(li.discountedTotalSet)]);
        }
        // Anything on the order here that Shopify no longer lists was removed.
        await query(
          `DELETE FROM sd_order_line_items
            WHERE order_id = $1 AND NOT (shopify_gid = ANY($2))`, [row.id, seen]);
      }

      /* Refunds likewise: an amount can be adjusted after the fact, and
         DO NOTHING froze whatever arrived first. Not pruned, though -- a refund
         is not un-issued, and `refunds/create` may deliver one the order query
         has not caught up with yet, so absence here does not mean removal. */
      for (const rf of o.refunds ?? []) {
        await query(
          `INSERT INTO sd_refunds (order_id, shopify_gid, total_refunded, shopify_created_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (shopify_gid) DO UPDATE SET
             total_refunded = EXCLUDED.total_refunded`,
          [row.id, rf.id, shopMoney(rf.totalRefundedSet), rf.createdAt]);
      }
      n++;
    }

    await this.refreshCustomerSpend([...touchedCustomers]);
    await this.markSync('orders', n);
    return n;
  }

  /**
   * Initial load, and any large historical pull.
   *
   * Fixture mode replays the captured order slice. Live, this starts a bulk
   * operation and waits for it -- which used to be a lie: the live source threw
   * "Live order paging runs through BackfillService, not here" and no such
   * service existed, so the initial sync simply did not work outside fixtures.
   */
  async backfill(since?: string): Promise<number> {
    if (this.shopify.source.kind !== 'live') {
      const orders = await this.shopify.source.orders();
      return this.upsertOrders(orders);
    }

    const { operationId, note } = await this.backfills.start(since);
    if (note) this.log.warn(note);
    const result = await this.backfills.waitAndIngest(
      operationId, (orders) => this.upsertOrders(orders));
    this.log.log(`backfill ingested ${result.orders} orders from ${result.objectCount} objects`);
    return result.orders;
  }

  /**
   * Register every webhook subscription this module needs.
   *
   * `verifyWebhooks` previously reported missing subscriptions and told
   * `sales.sync.manage` holders they had been "Re-registered" -- while no code
   * anywhere called `webhookSubscriptionCreate`. The notification was false and
   * the fast path never worked: Shopify was never asked to deliver anything.
   *
   * A subscription is pinned to the API version in the URL used to create it
   * and does not advance on its own, so the quarterly version bump has to
   * re-run this.
   */
  async registerWebhooks(): Promise<{ created: string[]; existing: string[]; skipped?: string }> {
    if (this.shopify.source.kind !== 'live') {
      return { created: [], existing: [], skipped: 'fixture source' };
    }
    if (!config.shopify.webhookBaseUrl) {
      /* Refusing is the right move. A subscription pointing at an unreachable
         address fails eight times over about four hours and is then deleted by
         Shopify automatically -- leaving a dashboard that looks healthy and
         receives nothing, which is the exact failure the watchdog exists for. */
      return { created: [], existing: [],
               skipped: 'SHOPIFY_WEBHOOK_BASE_URL is not set — Shopify cannot reach localhost' };
    }

    const callbackUrl =
      `${config.shopify.webhookBaseUrl.replace(/\/$/, '')}/api/v1/sales/webhooks/shopify`;

    const current = await this.shopify.source.graphql<any>(
      `{ webhookSubscriptions(first: 100) {
           nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
    const nodes = current?.webhookSubscriptions?.nodes ?? [];
    const already = new Set(
      nodes
        .filter((n: any) => n.endpoint?.callbackUrl === callbackUrl)
        .map((n: any) => n.topic));

    const created: string[] = [];
    const existing: string[] = [];

    for (const topic of WEBHOOK_TOPICS) {
      // The GraphQL enum is not derivable from the topic string by any
      // consistent rule -- note ORDERS_CREATE against ORDERS_UPDATED -- but
      // upper-snake happens to hold for every topic this module uses.
      const enumName = topic.toUpperCase().replace(/\//g, '_');
      if (already.has(enumName)) { existing.push(enumName); continue; }

      const res = await this.shopify.source.graphql<any>(
        `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
           webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
             webhookSubscription { id topic }
             userErrors { field message }
           }
         }`,
        { topic: enumName, sub: { callbackUrl, format: 'JSON' } });

      const errs = res?.webhookSubscriptionCreate?.userErrors ?? [];
      if (errs.length) {
        this.log.warn(`${enumName}: ${errs.map((e: any) => e.message).join('; ')}`);
        continue;
      }
      created.push(enumName);
    }

    this.log.log(`webhooks: ${created.length} created, ${existing.length} already present`);
    await this.markSync('webhooks', created.length + existing.length);
    return { created, existing };
  }

  /**
   * Read the shop's own currency, timezone, name and plan from Shopify and
   * store them.
   *
   * These used to come from the captured fixture, which was fine while the
   * fixture and the store were the same shop. Point the app at a different
   * store and the mirror inherits the old shop's settings: order rows carry
   * their real currency while every total is labelled with the seeded one, so
   * a page shows `USD 154` in the table and `EGP 1,269` in the summary above
   * it. The number is a sum of dollars wearing a pound sign.
   *
   * Currency and timezone are settings, not constants -- Egypt observes
   * daylight saving and a store can be re-denominated -- so this is a sync
   * step rather than a one-time seed value.
   */
  async syncShopSettings(): Promise<{ currency: string; timezone: string; name: string }> {
    if (this.shopify.source.kind !== 'live') {
      const shop = await this.shops.get();
      return { currency: shop.currency_code, timezone: shop.iana_timezone, name: shop.name };
    }

    const data = await this.shopify.source.graphql<any>(
      `{ shop { name myshopifyDomain currencyCode ianaTimezone
                plan { displayName } } }`);
    const sh = data?.shop;
    if (!sh) throw new Error('Shopify returned no shop record');

    const shop = await this.shops.get();
    await query(
      `UPDATE sd_shops
          SET name = $2, currency_code = $3, iana_timezone = $4, plan_name = $5,
              myshopify_domain = $6
        WHERE id = $1`,
      [shop.id, sh.name, sh.currencyCode, sh.ianaTimezone,
       sh.plan?.displayName ?? null, sh.myshopifyDomain]);

    this.shops.invalidate();
    this.log.log(`shop settings: ${sh.name}, ${sh.currencyCode}, ${sh.ianaTimezone}`);
    return { currency: sh.currencyCode, timezone: sh.ianaTimezone, name: sh.name };
  }

  /** Fields and enum values of one GraphQL type, straight from Shopify. */
  async describeType(typeName: string) {
    const data = await this.shopify.source.graphql<any>(
      `query($n: String!) {
         __type(name: $n) {
           name kind
           enumValues { name }
           fields {
             name
             type { name kind ofType { name kind ofType { name } } }
           }
         }
       }`, { n: typeName });

    const t = data?.__type;
    if (!t) return { type: typeName, found: false };

    /* GraphQL wraps types in NON_NULL and LIST shells, so the real name can be
       two or three levels down and every shell has a null `name`. The obvious
       recursion -- `ty?.name ?? unwrap(ty?.ofType)` -- never terminates on a
       null: `undefined?.name` is undefined, so it recurses on undefined
       forever and the `?? 'unknown'` fallback is never reached. A null check
       first, and a depth bound because the introspection query only asks three
       levels deep and anything deeper would return null anyway. */
    const unwrap = (ty: any, depth = 0): string => {
      if (!ty || depth > 5) return 'unknown';
      return ty.name ?? unwrap(ty.ofType, depth + 1);
    };

    return {
      type: t.name, kind: t.kind, found: true,
      enumValues: t.enumValues?.map((e: any) => e.name) ?? null,
      fields: t.fields?.map((f: any) => ({ name: f.name, type: unwrap(f.type) })) ?? null,
      /* The connection's own arguments, which is where a sortKey enum name
         actually lives -- knowing the field exists is not the same as knowing
         what it will accept. */
    };
  }

  /**
   * Do our numbers agree with Shopify's?
   *
   * Every dashboard puts a ShopifyQL figure next to a mirror figure -- total
   * sales beside collected, orders beside outstanding -- and nothing has ever
   * checked that the two are describing the same set of orders. They can drift
   * without either looking wrong: a backfill that stopped part-way leaves the
   * mirror short while ShopifyQL stays complete, and the screen carries on
   * rendering both.
   *
   * Three independent counts for one day:
   *   - Shopify's own order count, asked directly
   *   - ShopifyQL's aggregate, the source of every headline figure
   *   - our mirror, the source of every order-level figure
   *
   * They will not be identical and are not expected to be. ShopifyQL excludes
   * what Shopify decides to exclude; the mirror excludes test, cancelled and
   * deleted orders explicitly. The point is the *size* of the gap: a few orders
   * on a cancellation is ordinary, and a hundred is a mirror that never
   * finished loading.
   *
   * This is the acceptance test the design document calls the one that decides
   * whether the dashboard is finished. It was written down and never run,
   * because running it by hand means three queries in two places.
   */
  async reconcileCheck(date: string) {
    const shop = await this.shops.get();
    const tz = shop.iana_timezone || 'Africa/Cairo';
    const day = DateTime.fromISO(date, { zone: tz });
    if (!day.isValid) throw new BadRequestException(`${date} is not a real date`);

    const start = day.startOf('day').toJSDate();
    const end = day.endOf('day').toJSDate();

    const [mirror] = await query<any>(
      `SELECT COUNT(*)                                   AS orders,
              COALESCE(SUM(total_price), 0)              AS total_price,
              COALESCE(SUM(net_payment), 0)              AS collected,
              COALESCE(SUM(total_refunded), 0)           AS refunded,
              COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
              COUNT(*) FILTER (WHERE test)                     AS test_orders
         FROM sd_orders
        WHERE shop_id = $1 AND deleted_at IS NULL
          AND shopify_created_at >= $2 AND shopify_created_at <= $3`,
      [shop.id, start, end]);

    const [snapshot] = await query<any>(
      `SELECT metrics, is_final, captured_at FROM sd_metric_snapshots
        WHERE shop_id = $1 AND schema_name = 'sales' AND grain = 'day'
          AND dimensions = '{}'::jsonb
          AND bucket_start >= $2 AND bucket_start <= $3
        LIMIT 1`, [shop.id, start, end]);

    /* Shopify's own count, as a third opinion.
     *
     * Terms are joined by a space. Shopify's search syntax treats whitespace as
     * AND and a literal `AND` as a search term, so writing it out opened the
     * window to two days and returned 231 against a true 113 -- almost exactly
     * double, which is the signature the design document warns about for range
     * mistakes and which nearly sent a correct mirror back for a re-backfill.
     */
    let shopifyOrders: number | null = null;
    if (this.shopify.source.kind === 'live') {
      const d = await this.shopify.source.graphql<any>(
        `query($q: String!) { ordersCount(query: $q) { count } }`,
        { q: `created_at:>='${start.toISOString()}' created_at:<='${end.toISOString()}'` },
      ).catch(() => null);
      shopifyOrders = d?.ordersCount?.count ?? null;
    }

    const m = snapshot?.metrics ?? {};
    const liveMirrorOrders =
      Number(mirror?.orders ?? 0) - Number(mirror?.cancelled ?? 0) - Number(mirror?.test_orders ?? 0);

    /* The verdict rests on ShopifyQL against the mirror, not on Shopify's raw
       count.
    
       Those two are what the dashboards actually read -- every headline figure
       from one, every order-level figure from the other -- so their agreement
       is the thing that decides whether the screen is trustworthy. Shopify's
       own count is a useful third opinion but counts on its own terms, and it
       should never be the number that condemns a mirror. */
    const mirrorOrders = Number(mirror?.orders ?? 0);
    const qlOrders = m.orders == null ? null : Number(m.orders);
    const coreGap = qlOrders === null ? null : qlOrders - mirrorOrders;
    const gap = shopifyOrders === null ? null : shopifyOrders - mirrorOrders;

    return {
      date, timezone: tz,
      shopify: { orders: shopifyOrders },
      shopifyql: {
        orders: m.orders ?? null,
        grossSales: m.gross_sales ?? null,
        discounts: m.discounts ?? null,
        salesReversals: m.sales_reversals ?? null,
        netSales: m.net_sales ?? null,
        totalSales: m.total_sales ?? null,
        averageOrderValue: m.average_order_value ?? null,
        provisional: snapshot ? !snapshot.is_final : null,
        capturedAt: snapshot?.captured_at ?? null,
      },
      mirror: {
        orders: Number(mirror?.orders ?? 0),
        ordersExcludingCancelledAndTest: liveMirrorOrders,
        totalPrice: Number(mirror?.total_price ?? 0),
        collected: Number(mirror?.collected ?? 0),
        refunded: Number(mirror?.refunded ?? 0),
        cancelled: Number(mirror?.cancelled ?? 0),
        testOrders: Number(mirror?.test_orders ?? 0),
      },
      /* A verdict rather than a table to interpret. The thresholds are
         deliberately loose: this is meant to catch a mirror that is missing
         hundreds of orders, not to argue about one. */
      verdict:
        !snapshot ? 'No snapshot for this day — run the snapshot capture first.'
        : coreGap === null ? 'The snapshot has no order count for this day.'
        : coreGap === 0
          ? 'ShopifyQL and the mirror agree exactly. The two sources behind every figure on the dashboards are describing the same orders.'
        : Math.abs(coreGap) <= 3
          ? `ShopifyQL and the mirror differ by ${coreGap} order(s) — within what a cancellation or a late webhook explains.`
        : `ShopifyQL and the mirror differ by ${coreGap} orders. The mirror is incomplete for this day; re-run the backfill for it.`,

      /* Reported, never used to judge. Shopify's search counts drafts, tests
         and orders the other two exclude, so a difference here is information
         rather than a fault. */
      note: gap === null || gap === 0 ? undefined
        : `Shopify's own order count for this day is ${shopifyOrders}, ${Math.abs(gap)} ` +
          `${gap > 0 ? 'more' : 'fewer'} than the mirror. Shopify counts on its own terms ` +
          `— drafts and tests among them — so this is expected to differ and is not a fault on its own.`,
    };
  }

  get sourceKind() { return this.shopify.source.kind; }
  tokenStatus() { return this.shopify.tokens.status(); }
  ping() { return this.shopify.source.ping(); }

  /**
   * Recompute lifetime spend for a set of customers.
   *
   * Kept out of the customer upsert because it is a property of the orders, not
   * of the customer record Shopify sends. Shopify's `amountSpent` exists, but
   * reading it would mean trusting Shopify's definition of spend on a
   * cash-on-delivery store -- where an order placed and refused at the door
   * counts as neither collected nor cancelled. Summing `net_payment` from the
   * mirror is money that actually arrived, which is what "lifetime spend"
   * should mean here.
   *
   * Run after each batch rather than per order: a backfill writing 92,000
   * orders would otherwise recompute the same customer dozens of times.
   */
  async refreshCustomerSpend(customerIds: string[]): Promise<void> {
    if (!customerIds.length) return;

    /* Three derived columns, all recomputed from our own orders rather than
       taken from Shopify or accumulated as we go. Two of them used to be, and
       both were wrong in ways that only showed up on a cancellation.
    
       `orders_count` was Shopify's `numberOfOrders`, written whenever a webhook
       payload happened to carry the customer object. It counts on Shopify's
       basis, not ours -- and every customer figure here excludes test,
       cancelled and deleted orders, so the repeat-purchase rate was dividing
       one basis by another. Worse, cancelling an order does not send a customer
       update, so the count simply never came down.
    
       `first_order_at` was a running LEAST of every order date seen. If the
       earliest order was later cancelled or deleted, the column kept pointing
       at it -- and new-versus-returning compares each order against exactly
       that date, so one cancellation could reclassify a customer's whole
       history.
    
       Recomputing all three from the same filtered set makes them agree with
       each other and self-heal on cancel, delete and refund. It costs one
       grouped scan over the orders of the customers touched by a batch. */
    await query(
      `UPDATE sd_customers c
          SET total_spent    = agg.spent,
              orders_count   = agg.orders,
              first_order_at = agg.first_at,
              last_order_at  = agg.last_at
         FROM (
           SELECT o.customer_id,
                  COALESCE(SUM(o.net_payment), 0)  AS spent,
                  COUNT(*)                          AS orders,
                  MIN(o.shopify_created_at)         AS first_at,
                  MAX(o.shopify_created_at)         AS last_at
             FROM sd_orders o
            WHERE o.customer_id = ANY($1)
              AND o.test = false AND o.cancelled_at IS NULL AND o.deleted_at IS NULL
            GROUP BY o.customer_id
         ) agg
        WHERE c.id = agg.customer_id`, [customerIds]);

    /* A customer whose every order was cancelled or deleted drops out of the
       group above entirely, so the UPDATE never reaches them and they keep
       whatever they last had. Zeroed explicitly -- otherwise the one case where
       the count should certainly be nought is the one case it never changes. */
    await query(
      `UPDATE sd_customers c
          SET total_spent = 0, orders_count = 0, first_order_at = NULL
        WHERE c.id = ANY($1)
          AND NOT EXISTS (
            SELECT 1 FROM sd_orders o
             WHERE o.customer_id = c.id
               AND o.test = false AND o.cancelled_at IS NULL AND o.deleted_at IS NULL)`,
      [customerIds]);
  }

  /**
   * Reconciliation: the source of truth.
   *
   * Webhooks make the dashboard feel live; this makes it correct. Shopify says
   * plainly that delivery is not guaranteed, so every fifteen minutes this
   * pulls whatever changed since the last successful run and pushes it through
   * the same `upsertOrders` path a webhook would have taken. A missed delivery
   * costs minutes of staleness rather than a permanently wrong figure.
   *
   * Two properties matter more than the query itself. The window is widened by
   * five minutes behind the watermark, because an order updated in the same
   * second the previous run read the clock would otherwise fall between two
   * passes forever. And the watermark only advances on success -- a failed run
   * re-covers the same ground next time instead of leaving a hole nobody can
   * see.
   */
  async reconcile(): Promise<number> {
    if (this.shopify.source.kind !== 'live') return 0;

    const shop = await this.shops.get();
    const state = await one(
      `SELECT watermark FROM sd_sync_state WHERE shop_id = $1 AND resource = 'orders'`,
      [shop.id]);

    // First run has no watermark: take a day, not all of history. A full load
    // is the backfill's job and it uses a bulk operation for a reason.
    const since = new Date(
      state?.watermark
        ? new Date(state.watermark).getTime() - 5 * 60_000
        : Date.now() - 24 * 60 * 60_000);

    const filter = `updated_at:>=${since.toISOString()}`;
    let cursor: string | null = null;
    let seen = 0;
    let written = 0;

    /* Paged rather than bulk: this is a small delta and a bulk operation has a
       start-up cost measured in seconds. The page size is 50 because each order
       carries its line items, and a hundred of those is a large enough response
       to be worth avoiding. */
    for (let page = 0; page < 40; page++) {
      const data: any = await this.shopify.source.graphql<any>(
        `query($q: String!, $after: String) {
           orders(first: 50, query: $q, after: $after, sortKey: UPDATED_AT) {
             pageInfo { hasNextPage endCursor }
             nodes {
               id name createdAt processedAt updatedAt cancelledAt cancelReason test
               displayFinancialStatus displayFulfillmentStatus sourceName tags
               currencyCode presentmentCurrencyCode
               totalPriceSet          { shopMoney { amount } presentmentMoney { amount } }
               currentTotalPriceSet   { shopMoney { amount } }
               subtotalPriceSet       { shopMoney { amount } }
               currentSubtotalPriceSet{ shopMoney { amount } }
               totalDiscountsSet      { shopMoney { amount } }
               totalTaxSet            { shopMoney { amount } }
               totalShippingPriceSet  { shopMoney { amount } }
               totalRefundedSet       { shopMoney { amount } }
               netPaymentSet          { shopMoney { amount } }
               totalOutstandingSet    { shopMoney { amount } }
               shippingAddress { city province country zip }
               customer { id displayName email phone numberOfOrders createdAt }
               lineItems(first: 100) { nodes {
                 id title sku quantity currentQuantity
                 product { id } variant { id title }
                 originalTotalSet   { shopMoney { amount } }
                 discountedTotalSet { shopMoney { amount } }
               } }
               refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
             }
           }
         }`, { q: filter, after: cursor });

      const conn = data?.orders;
      const nodes = conn?.nodes ?? [];
      seen += nodes.length;
      if (nodes.length) written += await this.upsertOrders(nodes);

      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    this.log.log(`reconcile: ${seen} orders changed since ${since.toISOString()}, ${written} written`);
    // markSync advances the watermark, and it is only reached on success.
    await this.markSync('orders', written);
    return written;
  }

  /**
   * The subscription watchdog. Not optional: after eight consecutive failures
   * Shopify silently deletes an Admin-API-created subscription, and the
   * dashboard then keeps rendering yesterday's numbers with nobody noticing.
   */
  async verifyWebhooks(): Promise<{ subscribed: string[]; missing: string[] }> {
    let subscribed: string[] = [];
    if (this.shopify.source.kind === 'live') {
      const data = await this.shopify.source.graphql<any>(
        `{ webhookSubscriptions(first: 50) { nodes { topic endpoint { __typename } } } }`);
      subscribed = (data?.webhookSubscriptions?.nodes ?? []).map((n: any) => n.topic);
    }
    const expected = WEBHOOK_TOPICS.map((t) => t.toUpperCase().replace('/', '_'));
    const missing = expected.filter((t) => !subscribed.includes(t));

    if (missing.length && this.shopify.source.kind === 'live') {
      /* Actually re-register, then say what happened. This used to send the
         notification without calling anything, so an operator reading
         "Re-registered" had been told a subscription was restored when nothing
         had been. */
      const result = await this.registerWebhooks().catch((e) => {
        this.log.error(`re-registration failed: ${e.message}`);
        return { created: [] as string[], existing: [] as string[], skipped: e.message };
      });
      const body = result.skipped
        ? `Missing: ${missing.join(', ')}. Re-registration skipped — ${result.skipped}`
        : `Missing: ${missing.join(', ')}. Re-registered: ${result.created.join(', ') || 'none'}`;
      await this.notifications.notifyPermissionHolders(
        PERMISSIONS.SYNC_MANAGE, 'sales-dashboard',
        'Shopify webhook subscriptions missing', body, 'WARNING');
    }
    await this.markSync('webhooks', subscribed.length);
    await redis().set('sales:webhooks:lastCheck', new Date().toISOString());
    return { subscribed, missing };
  }

  /** Retention. Shopify sets no maximum period -- the obligation is
   *  purpose-bound, so these values are Worood's chosen policy. */
  async runRetention() {
    const payloads = await query(
      `UPDATE sd_webhook_events SET payload = NULL, payload_trimmed_at = now()
        WHERE payload IS NOT NULL
          AND received_at < now() - ($1 || ' days')::interval
        RETURNING id`, [String(config.sync.rawPayloadRetentionDays)]);

    const pii = await query(
      `UPDATE sd_customers
          SET display_name = NULL, email = NULL, phone = NULL,
              address_city = NULL, address_province = NULL, address_zip = NULL,
              pii_purged_at = now()
        WHERE pii_purged_at IS NULL
          AND COALESCE(last_order_at, shopify_created_at) < now() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM sd_orders o
             WHERE o.customer_id = sd_customers.id
               AND o.shopify_created_at > now() - ($1 || ' days')::interval)
        RETURNING id`, [String(config.sync.customerPiiRetentionDays)]);

    this.log.log(`retention: ${payloads.length} payloads trimmed, ${pii.length} customers purged`);
    return { payloadsTrimmed: payloads.length, customersPurged: pii.length };
  }

  private async markSync(resource: string, records: number, error?: string) {
    const shop = await this.shops.get();
    await query(
      `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records, error)
       VALUES ($1,$2, now(), now(), CASE WHEN $4::text IS NULL THEN now() END,
               CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END, $3, $4)
       ON CONFLICT (shop_id, resource) DO UPDATE
         SET watermark = CASE WHEN $4::text IS NULL THEN now() ELSE sd_sync_state.watermark END,
             last_run_at = now(),
             last_ok_at = CASE WHEN $4::text IS NULL THEN now() ELSE sd_sync_state.last_ok_at END,
             status = CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END,
             records = EXCLUDED.records, error = $4`,
      [shop.id, resource, records, error ?? null]);
  }

  async health(): Promise<SyncHealthResponse> {
    const shop = await this.shops.get();
    const resources = await query(
      `SELECT resource, watermark, last_run_at, last_ok_at, status, error, records
         FROM sd_sync_state WHERE shop_id = $1 ORDER BY resource`, [shop.id]);

    const counts = await one(
      `SELECT COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours') AS received,
              COUNT(*) FILTER (WHERE status = 'STALE' AND received_at > now() - interval '24 hours') AS stale
         FROM sd_webhook_events`);
    const dupes = parseInt((await redis().get('sales:webhooks:dupes24h')) || '0', 10);
    const lastCheck = await redis().get('sales:webhooks:lastCheck');
    const waiting = await redis().llen('sales:webhooks');

    return {
      shop: { name: shop.name, domain: shop.myshopify_domain,
              plan: shop.plan_name, apiVersion: shop.api_version },
      resources: resources.map((r) => {
        const lag = r.last_ok_at ? Math.round((Date.now() - new Date(r.last_ok_at).getTime()) / 1000) : null;
        return {
          resource: r.resource,
          watermark: r.watermark ? new Date(r.watermark).toISOString() : null,
          lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
          lastOkAt: r.last_ok_at ? new Date(r.last_ok_at).toISOString() : null,
          status: r.status, error: r.error, records: r.records,
          lagSeconds: lag,
          // A dashboard that quietly shows week-old numbers is the failure mode
          // that destroys trust, so "healthy" is an explicit server-side verdict
          // rather than something the UI has to infer.
          healthy: r.status === 'OK' && lag !== null && lag < 24 * 3600,
        };
      }),
      queue: { waiting, active: 0, failed: 0, completed: 0 },
      webhooks: {
        subscribed: this.shopify.source.kind === 'live' ? [] : WEBHOOK_TOPICS,
        missing: [],
        lastCheckedAt: lastCheck,
        received24h: Number(counts.received), duplicates24h: dupes,
        stale24h: Number(counts.stale),
      },
      costGovernor: await this.shopify.governor.status(),
      token: await this.shopify.tokens.status(),
    };
  }
}

@Controller('sales/admin/sync')
export class SyncController {
  constructor(
    private sync: SyncService,
    private snapshots: SnapshotService,
    private abandonedCheckouts: AbandonedCheckoutService,
    private credit: StoreCreditService,
  ) {}

  @Get()
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  health() { return this.sync.health(); }

  /**
   * The initial sync. `since` is an ISO date; without it Shopify serves the
   * last sixty days unless the app holds `read_all_orders`, and does so
   * silently rather than erroring.
   *
   * This runs a bulk operation and waits for it, so on a full history it can
   * take minutes. It is a deliberate operator action, not something a page
   * load triggers.
   */
  @Post('backfill')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async backfill(@Body() body: { since?: string } = {}) {
    /* Shopify's own words, passed through. The global filter turns anything
       uncaught into "Something went wrong", which for an operator-triggered
       action is the least useful thing it could say -- the reason a bulk export
       was refused is nearly always specific and actionable. */
    try {
      return { orders: await this.sync.backfill(body?.since) };
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Backfill failed');
    }
  }

  /** Register the webhook subscriptions with Shopify. Needs a public HTTPS
   *  address in SHOPIFY_WEBHOOK_BASE_URL; refuses politely without one. */
  @Post('webhooks/register')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  register() { return this.sync.registerWebhooks(); }

  /**
   * What the server actually believes, as opposed to what the .env appears to
   * say. Written after an afternoon spent guessing why a live-looking install
   * returned 200 and no rows: the answer needed the process's own view of its
   * configuration, and nothing exposed it.
   *
   * Reports no secrets -- the client id is truncated and the secret only ever
   * appears as present or absent.
   */
  /**
   * Compare one day across Shopify, ShopifyQL and the mirror.
   *
   *   GET /sales/admin/sync/reconcile-check?date=2026-09-01
   *
   * Run it for a normal day, a day with refunds, and a day with a cancellation.
   * Until it passes, the figures on the dashboards are unverified.
   */
  @Get('reconcile-check')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  reconcileCheck(@Query('date') date?: string) {
    if (!date) throw new BadRequestException('Pass ?date=YYYY-MM-DD');
    return this.sync.reconcileCheck(date);
  }

  @Get('diagnostics')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async diagnostics() {
    const cfg = config.shopify;
    const out: Record<string, unknown> = {
      sourceKind: this.sync.sourceKind,
      tokenStrategy: cfg.tokenStrategy,
      shopDomain: cfg.shopDomain,
      apiVersion: cfg.apiVersion,
      clientIdSet: !!cfg.clientId,
      clientIdPrefix: cfg.clientId ? `${cfg.clientId.slice(0, 6)}…` : null,
      clientSecretSet: !!cfg.clientSecret && cfg.clientSecret !== 'dev-webhook-secret',
      webhookBaseUrl: cfg.webhookBaseUrl || null,
      scheduleEnabled: cfg.scheduleEnabled,
    };

    if (!cfg.clientId || !cfg.clientSecret || cfg.clientSecret === 'dev-webhook-secret') {
      out.verdict = 'SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set in the environment.';
      return out;
    }

    /* Redis is checked first and separately. It is a dependency of the token
       manager, so without it every Shopify verdict below would be a confusing
       proxy for "Redis is down". */
    try {
      await redis().ping();
      out.redis = 'reachable';
    } catch (e: any) {
      out.redis = `unreachable — ${e?.message ?? e}`;
      out.verdict = 'Redis is not running. The sales module cannot fetch a token without it.';
      return out;
    }

    try {
      out.token = await this.sync.tokenStatus();
      out.ping = await this.sync.ping();
      out.verdict = 'Connected.';
    } catch (e: any) {
      out.verdict = `Shopify call failed: ${e?.message ?? e}`;
    }
    return out;
  }

  /** Pull the shop's currency, timezone, name and plan from Shopify. Worth
   *  running after pointing the app at a different store. */
  @Post('shop')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  shopSettings() { return this.sync.syncShopSettings(); }

  /** Pull abandoned checkouts on demand. Runs every thirty minutes on the
   *  schedule; this is for the first load and for impatience. */
  /**
   * Ask Shopify what a type actually looks like.
   *
   * Written after an abandoned-checkout query was assembled from the
   * documentation and rejected for two separate reasons at once -- an invalid
   * sort key and a field that does not exist on the type. GraphQL reports all
   * of them together and the message gets truncated in logs, so guessing one
   * field at a time is the slowest possible way to converge.
   *
   * Read-only, needs sales.sync.manage, and uses the token the server already
   * holds -- which is the point: it works without anyone copying credentials
   * into a REST client and getting the shop domain wrong on the way.
   */
  @Get('schema/:typeName')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async schema(@Param('typeName') typeName: string) {
    return this.sync.describeType(typeName);
  }

  /**
   * Several types at once, for the questions that need more than one answer.
   *
   * `GET /schema/AbandonedCheckout` told us the field list but not what the
   * sort key would accept, and finding that out took a second request. Asking
   * for a set is one round trip and one answer.
   *
   *   ?types=StoreCreditAccount,StoreCreditAccountTransaction
   */
  @Get('schema')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async schemas(@Query('types') types = '') {
    const names = types.split(',').map((t) => t.trim()).filter(Boolean);
    if (!names.length) throw new BadRequestException('Pass ?types=Type1,Type2');
    return Promise.all(names.map((n) => this.sync.describeType(n)));
  }

  /** Export store credit on demand. Runs nightly otherwise. */
  @Post('store-credit')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async storeCredit() { return { transactions: await this.credit.sync() }; }

  @Post('abandoned')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async abandoned() { return { checkouts: await this.abandonedCheckouts.sync() }; }

  @Post('reconcile')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async reconcile() { return { orders: await this.sync.reconcile() }; }

  /** Fill hour-grain history so day comparisons read from the store rather than
   *  calling Shopify. Run once; the nightly job keeps the recent fortnight. */
  @Post('snapshots/hourly-backfill')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async hourlyBackfill(@Body() body: { months?: number } = {}) {
    return { rows: await this.snapshots.backfillHourly(body?.months ?? 13) };
  }

  @Post('snapshots')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async snapshot() { return this.snapshots.captureAll(); }

  @Post('webhooks/verify')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  verify() { return this.sync.verifyWebhooks(); }

  @Post('retention')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  retention() { return this.sync.runRetention(); }
}

/**
 * The numeric part of a Shopify order name, or null.
 *
 * `#1001` gives 1001. So does `WOR-1001-A`, which is the point: the column
 * exists for sorting and for the number people read out, and the name itself is
 * kept verbatim alongside it.
 *
 * `Number.isSafeInteger` is the guard that was missing. The column is now
 * bigint and handles ten digits comfortably, but a name with twenty digits in
 * it would exceed what JavaScript can represent exactly, and a silently wrong
 * number is worse than no number -- the name column still has the truth.
 */
function orderNumber(name: unknown): number | null {
  const digits = String(name ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}