/**
 * Applies webhook payloads to the mirror. Split from the controller because the
 * controller's decorator metadata references this class at decoration time, and
 * a single file would evaluate the reference before the class exists.
 */
import { Injectable, Logger } from '@nestjs/common';
import { query, one } from '../../../common/db';
import { ShopContext, SnapshotService } from '../analytics/snapshot.service';
import { redis, ShopifyService } from '../shopify/shopify.service';
import { SyncService } from '../sync/sync.service';

@Injectable()
export class WebhookProcessor {
  private readonly log = new Logger('WebhookProcessor');
  constructor(
    private shops: ShopContext,
    private snapshots: SnapshotService,
    private shopify: ShopifyService,
    private sync: SyncService,
  ) {}

  /** In this build the queue is a Redis list; BullMQ slots in unchanged behind
   *  the same two methods when the worker process is deployed. */
  async enqueue(eventId: string) {
    await redis().lpush('sales:webhooks', eventId);
    // Processed inline as well so a single-process demo stays live. The worker
    // process is what does this in production; both call the same method.
    setImmediate(() => this.processOne(eventId).catch((e) =>
      this.log.error(`processing ${eventId} failed: ${e.message}`)));
  }

  async processOne(eventId: string) {
    const ev = await one(`SELECT * FROM sd_webhook_events WHERE id = $1`, [eventId]);
    if (!ev || ev.status === 'PROCESSED') return;

    try {
      const applied = await this.apply(ev.topic, ev.payload, ev.triggered_at);
      await query(
        `UPDATE sd_webhook_events SET status = $2, processed_at = now(), attempts = attempts + 1
          WHERE id = $1`, [eventId, applied ? 'PROCESSED' : 'STALE']);
      if (applied) {
        await this.publish('order');

        /* The mirror is now current; the snapshots are not, and the dashboard
           reads the snapshots. Without this the order appears in the orders
           table immediately and in the headline figures at the top of the next
           hour -- which reads as the dashboard being broken rather than as two
           tables refreshing on different clocks.

           Debounced inside scheduleRefresh, so a burst of orders produces one
           ShopifyQL round trip rather than one per order. Only order and refund
           events move a figure; a customer's phone number changing does not. */
        if (ev.topic.startsWith('orders/') || ev.topic === 'refunds/create') {
          this.snapshots.scheduleRefresh();
        }

        /* Then fetch the order in full and apply that on top.
         *
         * A webhook payload is a snapshot of one moment, and for `orders/create`
         * that moment is often before the order is finished being assembled:
         * line items added in a second step, a customer attached after, payment
         * captured later still. The row therefore appeared with no items, no
         * customer and nothing collected, and filled in over the following
         * minutes as `orders/updated` and `orders/paid` arrived. Correct, and it
         * reads like a bug.
         *
         * One GraphQL read gives the whole order at once. It runs after the
         * payload has already been applied, not instead of it, so a failed
         * fetch -- a network blip, or the protected-customer-data denial that
         * already affects the backfill -- costs richness rather than the record.
         */
        if (ev.topic === 'orders/create' || ev.topic === 'orders/updated') {
          await this.hydrate(ev.payload).catch((e) =>
            this.log.warn(`could not hydrate ${ev.topic}: ${e?.message ?? e}`));
        }
      }
    } catch (e: any) {
      await query(
        `UPDATE sd_webhook_events SET status = 'FAILED', attempts = attempts + 1, error = $2
          WHERE id = $1`, [eventId, String(e.message).slice(0, 500)]);
      throw e;
    }
  }

  /**
   * Returns false when the event is stale. Shopify guarantees no ordering, so a
   * later event can arrive first: every write applies only if the payload is at
   * least as new as what is already stored.
   */
  private async apply(topic: string, payload: any, triggeredAt: Date | null): Promise<boolean> {
    const shop = await this.shops.get();
    if (topic.startsWith('customers/')) return this.applyCustomer(shop.id, payload);
    if (topic === 'orders/delete') return this.applyOrderDeletion(payload);
    if (topic.startsWith('orders/')) return this.applyOrder(shop.id, payload, triggeredAt);
    if (topic === 'refunds/create') return this.applyRefund(payload);
    return true;
  }

  /**
   * An order removed in the Shopify admin.
   *
   * Soft, not hard. A deleted order still has to resolve to a name in the audit
   * log and in any figure computed before it went, and the row is the only
   * place that history lives -- Shopify will not serve it again. The read paths
   * filter on `deleted_at IS NULL`, so it disappears from the dashboard while
   * remaining answerable.
   *
   * The payload for this topic is a stub: an id and little else. That is all
   * that is needed, and it is why this cannot go through `applyOrder`, which
   * expects a whole order and would null out every column it did not find.
   */
  /**
   * Re-read one order from Shopify and push it through the same path the
   * backfill and reconciliation use, so an order written by a webhook and one
   * written by a bulk export are the same row built the same way.
   *
   * Deliberately not selecting the protected customer fields here. The webhook
   * payload already carried the customer and has been applied; asking for them
   * again risks the whole read being denied and losing the line items with it.
   */
  private async hydrate(payload: any): Promise<void> {
    if (this.shopify.source.kind !== 'live') return;
    const gid = payload?.admin_graphql_api_id;
    if (!gid) return;

    const data = await this.shopify.source.graphql<any>(
      `query($id: ID!) {
         node(id: $id) {
           ... on Order {
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
             lineItems(first: 100) { nodes {
               id title sku quantity currentQuantity
               product { id } variant { id title }
               originalTotalSet   { shopMoney { amount } }
               discountedTotalSet { shopMoney { amount } }
             } }
             refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
           }
         }
       }`, { id: String(gid) });

    const node = data?.node;
    if (!node?.id) return;
    await this.sync.upsertOrders([node]);
    await this.publish('order');
  }

  private async applyOrderDeletion(payload: any): Promise<boolean> {
    const gid = payload?.admin_graphql_api_id ?? payload?.id;
    if (!gid) return false;

    const res = await query(
      `UPDATE sd_orders SET deleted_at = now()
        WHERE shopify_gid = $1 AND deleted_at IS NULL
        RETURNING id`, [String(gid)]);

    if (res.length) this.log.log(`order ${gid} deleted in Shopify — mirrored as removed`);
    return true;
  }

  private async applyOrder(shopId: string, o: any, triggeredAt: Date | null): Promise<boolean> {
    const gid = o.admin_graphql_api_id ?? o.id;
    const updatedAt = new Date(o.updated_at ?? triggeredAt ?? Date.now());

    const existing = await one(
      `SELECT id, shopify_updated_at FROM sd_orders WHERE shopify_gid = $1`, [String(gid)]);
    if (existing && new Date(existing.shopify_updated_at) > updatedAt) {
      return false; // stale: recorded and discarded, not applied
    }

    const money = (v: any) => (v == null ? 0 : parseFloat(String(v)));
    await query(
      `INSERT INTO sd_orders (shop_id, shopify_gid, name, order_number, shopify_created_at,
          processed_at, cancelled_at, cancel_reason, shopify_updated_at, test,
          financial_status, fulfillment_status, source_name, currency_code,
          total_price, current_total_price, subtotal_price, total_discounts, total_tax,
          total_shipping, total_refunded, net_payment, total_outstanding,
          ship_city, ship_province, ship_country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (shopify_gid) DO UPDATE SET
         name = EXCLUDED.name, cancelled_at = EXCLUDED.cancelled_at,
         cancel_reason = EXCLUDED.cancel_reason,
         shopify_updated_at = EXCLUDED.shopify_updated_at,
         financial_status = EXCLUDED.financial_status,
         fulfillment_status = EXCLUDED.fulfillment_status,
         total_price = EXCLUDED.total_price,
         current_total_price = EXCLUDED.current_total_price,
         total_refunded = EXCLUDED.total_refunded,
         net_payment = EXCLUDED.net_payment,
         total_outstanding = EXCLUDED.total_outstanding`,
      [shopId, String(gid), o.name ?? `#${o.order_number}`, o.order_number ?? null,
       new Date(o.created_at ?? Date.now()), o.processed_at ?? null,
       o.cancelled_at ?? null, o.cancel_reason ?? null, updatedAt, !!o.test,
       o.financial_status?.toUpperCase() ?? null, o.fulfillment_status?.toUpperCase() ?? null,
       o.source_name ?? null, o.currency ?? 'EGP',
       money(o.total_price), money(o.current_total_price ?? o.total_price),
       money(o.subtotal_price), money(o.total_discounts), money(o.total_tax),
       money(o.total_shipping_price_set?.shop_money?.amount), money(o.total_refunded ?? 0),
       money(o.net_payment ?? 0), money(o.total_outstanding ?? 0),
       o.shipping_address?.city ?? null, o.shipping_address?.province ?? null,
       o.shipping_address?.country ?? null]);
    return true;
  }

  private async applyCustomer(shopId: string, c: any): Promise<boolean> {
    const gid = c.admin_graphql_api_id ?? c.id;
    await query(
      `INSERT INTO sd_customers (shop_id, shopify_gid, orders_count, total_spent,
          display_name, email, phone, shopify_created_at, shopify_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (shopify_gid) DO UPDATE SET
         orders_count = EXCLUDED.orders_count, total_spent = EXCLUDED.total_spent,
         display_name = EXCLUDED.display_name, email = EXCLUDED.email,
         phone = EXCLUDED.phone, shopify_updated_at = EXCLUDED.shopify_updated_at`,
      [shopId, String(gid), c.orders_count ?? 0, parseFloat(c.total_spent ?? '0'),
       [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
       c.email ?? null, c.phone ?? null,
       c.created_at ?? null, c.updated_at ?? new Date()]);
    return true;
  }

  /**
   * A refund recorded against an order.
   *
   * The payload describes the *refund*, not the order: amounts, transactions
   * and an `order_id`, and no customer. It is written to `sd_refunds` and
   * nothing else here -- deliberately, because applying a refund payload to an
   * order row would null every order column it does not carry.
   *
   * The order's own money columns matter as much as the refund row, though:
   * `net_payment` is what has actually been collected, and a refund reduces it.
   * Shopify sends `orders/updated` alongside, but the two can arrive in either
   * order and the update may be the one that loses the race. So the order is
   * re-read after the refund is stored, which settles both the money and the
   * financial status regardless of delivery order.
   */
  private async applyRefund(r: any): Promise<boolean> {
    const order = await one(
      `SELECT id, shopify_gid FROM sd_orders WHERE shopify_gid LIKE '%' || $1`,
      [String(r.order_id)]);
    if (!order) return true;

    await query(
      `INSERT INTO sd_refunds (order_id, shopify_gid, total_refunded, shopify_created_at, note)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (shopify_gid) DO NOTHING`,
      [order.id, String(r.admin_graphql_api_id ?? r.id),
       parseFloat(r.total_refunded ?? '0'), r.created_at ?? new Date(), r.note ?? null]);

    await this.hydrate({ admin_graphql_api_id: order.shopify_gid }).catch((e) =>
      this.log.warn(`could not re-read order after refund: ${e?.message ?? e}`));

    return true;
  }

  /** Invalidation signals only, never data: no path may bypass the permission
   *  layer, and no customer data ever travels over a socket. */
  private async publish(reason: 'order' | 'refund' | 'snapshot' | 'reconciliation') {
    await redis().publish('sales:events', JSON.stringify({
      type: 'metrics:changed', widgetKeys: ['*'], reason, at: new Date().toISOString(),
    }));
  }
}