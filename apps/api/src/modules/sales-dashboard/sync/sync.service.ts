/**
 * Reconciliation, the subscription watchdog, retention, and the health screen.
 *
 * Webhooks make the dashboard feel live; reconciliation makes it true. Shopify
 * states plainly that webhook delivery is not guaranteed, so the scheduled pull
 * is the source of truth and the fifteen-minute cadence is the practical upper
 * bound on how long a missed webhook can go unnoticed.
 */
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Post } from '@nestjs/common';
import { config } from '../../../common/config';
import { query, one } from '../../../common/db';
import { Permissions } from '../../../common/auth';
import { NotificationsService } from '../../../core/core.module';
import { ShopContext } from '../analytics/snapshot.service';
import { SnapshotService } from '../analytics/snapshot.service';
import { ShopifyService, redis } from '../shopify/shopify.service';
import { WEBHOOK_TOPICS } from '../webhooks/topics';
import { BackfillService } from './backfill.service';
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

  get sourceKind() { return this.shopify.source.kind; }
  tokenStatus() { return this.shopify.tokens.status(); }
  ping() { return this.shopify.source.ping(); }

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
  constructor(private sync: SyncService, private snapshots: SnapshotService) {}

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

  @Post('reconcile')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async reconcile() { return { orders: await this.sync.reconcile() }; }

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