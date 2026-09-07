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
import { StoreCreditService } from '../sync/store-credit.service';

@Injectable()
export class WebhookProcessor {
  private readonly log = new Logger('WebhookProcessor');
  constructor(
    private shops: ShopContext,
    private snapshots: SnapshotService,
    private shopify: ShopifyService,
    private sync: SyncService,
    private credit: StoreCreditService,
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
        /* Paid and cancelled are here too, and their absence was a real gap.
         *
         * Hydration re-reads the order and pushes it through `upsertOrders`,
         * which is also what recomputes the customer's lifetime spend. Lifetime
         * spend sums `net_payment` -- money actually collected -- and
         * `orders/paid` is precisely the event where that changes. Without it,
         * a payment moved the order row immediately and left the customer's
         * spend, and every Customer Insights figure built on it, waiting for
         * the fifteen-minute reconciliation to notice. */
        if (ev.topic === 'orders/create' || ev.topic === 'orders/updated'
            || ev.topic === 'orders/paid' || ev.topic === 'orders/cancelled') {
          await this.hydrateWithRetry(ev.payload, ev.topic);
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
    if (topic === 'shop/update') return this.applyShopUpdate();
    if (topic === 'app/uninstalled') return this.applyUninstall();
    if (topic === 'customers/delete') return this.applyCustomerDeletion(payload);
    if (topic.startsWith('customers/')) return this.applyCustomer(shop.id, payload);
    if (topic.startsWith('checkouts/')) return this.applyCheckout(topic, payload);
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
  /**
   * Hydration, retried, because more depends on it than was intended.
   *
   * Line items are written only by `upsertOrders` -- the webhook's own order
   * write does not touch them -- so hydration is the sole path by which an
   * order arriving through a webhook gets its contents. A single failure left
   * the order in the mirror showing zero items until reconciliation happened to
   * revisit it, which is the "ITEMS 0" seen on the orders page.
   *
   * Writing a second line-item path into the webhook handler would fix the
   * symptom and create the real problem: two places writing one table, which is
   * how orders_count and first_order_at went wrong. So the single path is made
   * reliable instead.
   *
   * Three attempts over about fifteen seconds, then give up and leave it to
   * reconciliation -- which is what the fifteen-minute sweep is for. The retry
   * covers a blip; it is not a substitute for the safety net.
   */
  private async hydrateWithRetry(payload: any, topic: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.hydrate(payload);
        return;
      } catch (e: any) {
        if (attempt === 2) {
          this.log.warn(
            `could not hydrate ${topic} after 3 attempts (${e?.message ?? e}) — ` +
            `the order is mirrored but its line items are not; reconciliation will fill them in`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      }
    }
  }

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

  /**
   * A customer removed in Shopify.
   *
   * Soft, like the order equivalent: their orders still have to resolve to
   * somebody, and the row is the only place that name survives. What changes is
   * that they stop being counted -- every customer figure is a ratio over the
   * base, so leaving them in quietly skews all of them.
   *
   * The payload is a stub, which is why this cannot go through `applyCustomer`
   * -- that expects a whole customer and would null every column it did not
   * find.
   */
  /**
   * The shop's own settings changed.
   *
   * The payload carries them, but they are re-read from Shopify instead: the
   * webhook body arrives in the REST resource shape and the fields do not line
   * up with the GraphQL ones the sync already knows how to write. One extra
   * call, on an event that fires rarely, in exchange for one code path.
   *
   * This matters more than it looks. Timezone decides how every ShopifyQL query
   * buckets a day, and currency labels every money figure on every dashboard.
   */
  private async applyShopUpdate(): Promise<boolean> {
    const before = await this.shops.get();
    const after = await this.sync.syncShopSettings();
    if (after.timezone !== before.iana_timezone || after.currency !== before.currency_code) {
      this.log.warn(
        `shop settings changed: ${before.currency_code}/${before.iana_timezone} → ` +
        `${after.currency}/${after.timezone}. Snapshots captured before now were ` +
        `aggregated on the old timezone; a full re-capture is advisable.`);
      // Recapture on the new settings rather than leaving mixed history.
      this.snapshots.scheduleRefresh(5_000);
    }
    return true;
  }

  /**
   * The app was removed from the store.
   *
   * Every subscription goes with it, so this is the last delivery that will
   * ever arrive. Nothing can be done about it from here -- the point is to say
   * so, loudly, while there is still a message to say it in. Otherwise the
   * dashboards keep rendering the last figures they had and look healthy for
   * as long as anyone cares to read them.
   */
  private async applyUninstall(): Promise<boolean> {
    this.log.error(
      'The Shopify app has been uninstalled. No further webhooks will arrive and ' +
      'every sync will fail from now on. The dashboards will keep showing the ' +
      'last data they received.');
    await query(
      `UPDATE sd_sync_state SET status = 'ERROR',
              error = 'App uninstalled from Shopify'
        WHERE shop_id = (SELECT id FROM sd_shops LIMIT 1)`);
    return true;
  }

  private async applyCustomerDeletion(payload: any): Promise<boolean> {
    const gid = payload?.admin_graphql_api_id ?? payload?.id;
    if (!gid) return false;
    const res = await query(
      `UPDATE sd_customers SET deleted_at = now()
        WHERE shopify_gid = $1 AND deleted_at IS NULL RETURNING id`, [String(gid)]);
    if (res.length) this.log.log(`customer ${gid} deleted in Shopify — mirrored as removed`);
    return true;
  }

  /**
   * A checkout created, updated or deleted.
   *
   * Only abandoned ones are of interest, and Shopify's definition of abandoned
   * -- contact details entered, purchase not completed -- is not something the
   * payload states directly. So rather than reasoning about it here, the
   * targeted pull is left to the thirty-minute sweep and this only handles the
   * two things a webhook can settle on its own: a checkout that completed, and
   * one that was deleted.
   *
   * Completion is the valuable half. It is what turns an abandonment into a
   * recovery, and it is the figure the whole dashboard turns on -- waiting half
   * an hour to learn that someone came back would make the recovery rate
   * lag exactly when someone is watching it.
   */
  private async applyCheckout(topic: string, payload: any): Promise<boolean> {
    const gid = payload?.admin_graphql_api_id;
    if (!gid) return true;

    if (topic === 'checkouts/delete') {
      await query(`DELETE FROM sd_abandoned_checkouts WHERE shopify_gid = $1`, [String(gid)]);
      return true;
    }

    // completed_at arriving means the customer came back and bought.
    if (payload.completed_at) {
      const res = await query(
        `UPDATE sd_abandoned_checkouts
            SET completed_at = COALESCE(completed_at, $2), shopify_updated_at = now()
          WHERE shopify_gid = $1 RETURNING id`,
        [String(gid), payload.completed_at]);
      if (res.length) this.log.log(`checkout ${gid} recovered`);
    }
    return true;
  }

  private async applyOrderDeletion(payload: any): Promise<boolean> {
    const gid = payload?.admin_graphql_api_id ?? payload?.id;
    if (!gid) return false;

    const res = await query(
      `UPDATE sd_orders SET deleted_at = now()
        WHERE shopify_gid = $1 AND deleted_at IS NULL
        RETURNING id`, [String(gid)]);

    if (res.length) {
      this.log.log(`order ${gid} deleted in Shopify — mirrored as removed`);
      /* The order is excluded from every figure now, and lifetime spend is a
         stored sum rather than a live one -- so it has to be told. Otherwise a
         deleted order keeps contributing to the customer's spend indefinitely,
         which is the one place a soft delete can still be counted. */
      const owner = await one(
        `SELECT customer_id FROM sd_orders WHERE shopify_gid = $1`, [String(gid)]);
      if (owner?.customer_id) {
        await this.sync.refreshCustomerSpend([owner.customer_id]);
      }
    }
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
    const applied = await this.writeOrder(shopId, o, gid, updatedAt, money);

    /* Refresh the customer's statistics here rather than leaving it to
       hydration.
    
       Hydration is best-effort and catches its own errors, by design -- losing
       richness is better than losing the record. But that made every customer
       figure depend on an optional step succeeding: a failed hydrate left the
       order updated and orders_count, first_order_at and total_spent frozen
       until reconciliation happened to touch the same order again.
    
       This path writes the order, so this path owns the consequences. */
    const owner = await one(
      `SELECT customer_id FROM sd_orders WHERE shopify_gid = $1`, [String(gid)]);
    if (owner?.customer_id) {
      await this.sync.refreshCustomerSpend([owner.customer_id]).catch((e) =>
        this.log.warn(`could not refresh customer stats: ${e?.message ?? e}`));
    }
    return applied;
  }

  private async writeOrder(
    shopId: string, o: any, gid: any, updatedAt: Date, money: (v: any) => number,
  ): Promise<boolean> {
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
    /* Identity only. `orders_count` and `total_spent` are seeded on insert so a
       brand-new customer is not zero for a moment, and are deliberately NOT
       updated on conflict.
    
       Shopify counts on its own basis; every customer figure here excludes
       test, cancelled and deleted orders. Letting this payload overwrite them
       would undo whatever `refreshCustomerSpend` last computed, and the two
       would take turns winning depending on which webhook arrived last -- a
       repeat-purchase rate that changes when a customer edits their phone
       number is the kind of wrong nobody thinks to look for. */
    await query(
      `INSERT INTO sd_customers (shop_id, shopify_gid, orders_count, total_spent,
          display_name, email, phone, shopify_created_at, shopify_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (shopify_gid) DO UPDATE SET
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
       -- Corrective: a refund amount can be adjusted after it is recorded, and
       -- DO NOTHING would freeze whichever value arrived first.
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shopify_gid) DO UPDATE SET
         total_refunded = EXCLUDED.total_refunded, note = EXCLUDED.note`,
      [order.id, String(r.admin_graphql_api_id ?? r.id),
       parseFloat(r.total_refunded ?? '0'), r.created_at ?? new Date(), r.note ?? null]);

    await this.hydrate({ admin_graphql_api_id: order.shopify_gid }).catch((e) =>
      this.log.warn(`could not re-read order after refund: ${e?.message ?? e}`));

    /* A refund is the main way store credit comes into existence -- a return
       taken as credit rather than cash. The full export runs nightly, which
       would leave a credit issued this morning invisible until tomorrow, so the
       one customer involved is refreshed now. Cheap: one customer, not 37,000. */
    const owner = await one(
      `SELECT c.shopify_gid FROM sd_orders o
         JOIN sd_customers c ON c.id = o.customer_id
        WHERE o.id = $1`, [order.id]);
    if (owner?.shopify_gid) {
      await this.credit.syncCustomer(owner.shopify_gid).catch((e) =>
        this.log.warn(`could not refresh store credit after refund: ${e?.message ?? e}`));
    }

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