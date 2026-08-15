/**
 * Reconciliation, the subscription watchdog, retention, and the health screen.
 *
 * Webhooks make the dashboard feel live; reconciliation makes it true. Shopify
 * states plainly that webhook delivery is not guaranteed, so the scheduled pull
 * is the source of truth and the fifteen-minute cadence is the practical upper
 * bound on how long a missed webhook can go unnoticed.
 */
import { Body, Controller, Get, Injectable, Logger, Post } from '@nestjs/common';
import { config } from '../../../common/config';
import { query, one } from '../../../common/db';
import { Permissions } from '../../../common/auth';
import { NotificationsService } from '../../../core/core.module';
import { ShopContext } from '../analytics/snapshot.service';
import { SnapshotService } from '../analytics/snapshot.service';
import { ShopifyService, redis } from '../shopify/shopify.service';
import { WEBHOOK_TOPICS } from '../webhooks/webhooks';
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
  ) {}

  /** Upsert path shared by the backfill and by reconciliation, so an order
   *  written by either takes exactly the same route into the mirror. */
  async upsertOrders(orders: any[]): Promise<number> {
    const shop = await this.shops.get();
    let n = 0;

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
           ON CONFLICT (shopify_gid) DO UPDATE SET
             orders_count = EXCLUDED.orders_count, display_name = EXCLUDED.display_name,
             email = EXCLUDED.email, phone = EXCLUDED.phone,
             last_order_at = GREATEST(sd_customers.last_order_at, EXCLUDED.last_order_at)
           RETURNING id`,
          [shop.id, o.customer.id, o.customer.numberOfOrders ?? 0,
           o.customer.displayName ?? null, o.customer.email ?? null, o.customer.phone ?? null,
           o.shippingAddress?.city ?? null, o.shippingAddress?.province ?? null,
           o.shippingAddress?.country ?? null, o.customer.createdAt ?? null,
           new Date(o.createdAt)]);
        customerId = c.id;
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
           customer_id = EXCLUDED.customer_id,
           cancelled_at = EXCLUDED.cancelled_at, cancel_reason = EXCLUDED.cancel_reason,
           shopify_updated_at = EXCLUDED.shopify_updated_at,
           financial_status = EXCLUDED.financial_status,
           fulfillment_status = EXCLUDED.fulfillment_status,
           total_price = EXCLUDED.total_price,
           current_total_price = EXCLUDED.current_total_price,
           total_refunded = EXCLUDED.total_refunded,
           net_payment = EXCLUDED.net_payment,
           total_outstanding = EXCLUDED.total_outstanding
         RETURNING id`,
        [shop.id, o.id, o.name, parseInt(String(o.name).replace(/\D/g, ''), 10) || null,
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

      for (const li of o.lineItems?.nodes ?? []) {
        await query(
          `INSERT INTO sd_order_line_items (order_id, shopify_gid, product_gid, variant_gid,
              title, variant_title, sku, quantity, current_quantity, original_total, discounted_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (shopify_gid) DO NOTHING`,
          [row.id, li.id, li.product?.id ?? null, li.variant?.id ?? null,
           li.title, li.variant?.title ?? null, li.sku ?? null,
           li.quantity ?? 0, li.currentQuantity ?? li.quantity ?? 0,
           shopMoney(li.originalTotalSet), shopMoney(li.discountedTotalSet)]);
      }
      for (const rf of o.refunds ?? []) {
        await query(
          `INSERT INTO sd_refunds (order_id, shopify_gid, total_refunded, shopify_created_at)
           VALUES ($1,$2,$3,$4) ON CONFLICT (shopify_gid) DO NOTHING`,
          [row.id, rf.id, shopMoney(rf.totalRefundedSet), rf.createdAt]);
      }
      n++;
    }

    await this.markSync('orders', n);
    return n;
  }

  /** Initial load, and any large historical pull. In fixture mode this replays
   *  the captured order slice; live, it runs a bulk operation. */
  async backfill(): Promise<number> {
    const orders = await this.shopify.source.orders();
    return this.upsertOrders(orders);
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
      await this.notifications.notifyPermissionHolders(
        PERMISSIONS.SYNC_MANAGE, 'sales-dashboard',
        'Shopify webhook subscriptions missing',
        `Re-registered: ${missing.join(', ')}`, 'WARNING');
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
  constructor(private sync: SyncService, private snapshots: SnapshotService) {}

  @Get()
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  health() { return this.sync.health(); }

  @Post('backfill')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async backfill() { return { orders: await this.sync.backfill() }; }

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
