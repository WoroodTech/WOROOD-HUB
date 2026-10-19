/**
 * Reconciliation, the subscription watchdog, retention, and the health screen.
 *
 * Webhooks make the dashboard feel live; reconciliation makes it true. Shopify
 * states plainly that webhook delivery is not guaranteed, so the scheduled pull
 * is the source of truth and the fifteen-minute cadence is the practical upper
 * bound on how long a missed webhook can go unnoticed.
 */
import { NotFoundException, ConflictException, BadRequestException, Body, Controller, Get, Injectable, Logger, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { config } from '../../../common/config';
import { DateTime } from 'luxon';
import { query, one, tx } from '../../../common/db';
import { CurrentUser, Permissions, type Principal } from '../../../common/auth';
import { AuditService } from '../../../core/core.module';
import { NotificationsService } from '../../../core/core.module';
import { ShopContext } from '../analytics/snapshot.service';
import { SnapshotService } from '../analytics/snapshot.service';
import { ShopifyService, redis } from '../shopify/shopify.service';
import { WEBHOOK_TOPICS } from '../webhooks/topics';
import { BackfillService } from './backfill.service';
import {
  RECONCILE_MAX_PAGES, RECONCILE_PAGE_SIZE, nextResume, nextWatermark,
  paginateOrders, resumePlan,
} from './reconcile-pages';
import { AbandonedCheckoutService } from './abandoned-checkout.service';
import { StoreCreditService } from './store-credit.service';
import { PERMISSIONS, SyncHealthResponse } from '../../../contract';
import { MAX_ATTEMPTS } from '../webhooks/webhook-lifecycle';
import type { FailedWebhookEventsResponse, ReplayWebhookEventResponse } from '../../../contract';

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
  /**
   * Write orders into the mirror. Does not touch `sd_sync_state`.
   *
   * It used to mark `orders` itself, which was wrong twice over. Both the
   * backfill and reconciliation pass through here, so a backfill writing in
   * batches stamped OK over its own RUNNING status every few seconds -- the
   * Data & Sync screen showed a finished job while ninety thousand orders were
   * still arriving.
   *
   * The second problem was quieter and worse. `markSync` advances the
   * watermark, and reconciliation resumes from it. A backfill covering all of
   * history would therefore set the watermark to now on completion, and the
   * next reconciliation would skip everything that changed during the import --
   * thirteen minutes of edits, silently missed, on the one run where the mirror
   * is most likely to be out of date.
   *
   * Marking is the caller's business: reconciliation owns `orders` and its
   * watermark, the backfill owns `orders_backfill` and has no watermark to
   * advance.
   */
  async upsertOrders(orders: any[]): Promise<number> {
    const shop = await this.shops.get();
    let n = 0;
    /* Collected as we go and recomputed once at the end. Lifetime spend depends
       on the orders written in this batch, so it cannot be part of the customer
       upsert below -- the orders do not exist yet at that point. */
    const touchedCustomers = new Set<string>();

    for (const o of orders) {
      const updatedAt = new Date(o.updatedAt ?? o.createdAt);

      /* One order, one transaction.
      
         The order row, its customer, its line items and its refunds used to be
         four independent statements. A crash between them left an order whose
         total said one thing and whose lines said another -- and the figures on
         the finance dashboard are drawn from both. Per order rather than per
         batch: a batch of fifty in one transaction holds row locks for the
         length of fifty Shopify-sized writes, and one malformed order would
         roll back the other forty-nine. */
      const applied = await tx<{ written: boolean; customerId: string | null }>(async (c) => {
        const first = async (sql: string, params: unknown[]) =>
          (await c.query(sql, params)).rows[0];

        let linkedCustomer: string | null = null;
        if (o.customer?.id) {
          const cu = await first(
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
          linkedCustomer = cu.id;
        }

        const row = await first(
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
             total_outstanding = EXCLUDED.total_outstanding,

             -- The components of the total, which used to be frozen at whatever
             -- the first write saw.
             --
             -- total_price was updated and these were not, so an order edited in
             -- Shopify -- a line removed, a discount applied -- left the mirror
             -- stating a total that its own subtotal, discounts, tax and
             -- shipping did not add up to. The finance dashboard reads the
             -- components and the headline from the same row, so the two
             -- disagreed on screen.
             subtotal_price = EXCLUDED.subtotal_price,
             current_subtotal_price = EXCLUDED.current_subtotal_price,
             total_discounts = EXCLUDED.total_discounts,
             total_tax = EXCLUDED.total_tax,
             total_shipping = EXCLUDED.total_shipping,
             presentment_total_price = EXCLUDED.presentment_total_price,

             -- Mutable in Shopify and read by the dashboards: processed_at
             -- arrives after an order is paid, and tags are edited constantly --
             -- the fulfilment tagging this store runs on is a tag change and
             -- nothing else, so a stale tag column is a wrong answer to the
             -- question the Operations screen asks.
             processed_at = EXCLUDED.processed_at,
             source_name = EXCLUDED.source_name,
             tags = EXCLUDED.tags,

             -- Additive, for the same reason as customer_id: the hydration read
             -- omits shippingAddress, so a plain assignment would blank the
             -- address seconds after a webhook delivered it.
             ship_city = COALESCE(EXCLUDED.ship_city, sd_orders.ship_city),
             ship_province = COALESCE(EXCLUDED.ship_province, sd_orders.ship_province),
             ship_country = COALESCE(EXCLUDED.ship_country, sd_orders.ship_country)

           -- The ordering guard, enforced by the database rather than by a read
           -- taken moments earlier.
           --
           -- It used to be a SELECT followed by an unconditional upsert. Between
           -- the two, nothing held the row: the webhook worker and
           -- reconciliation could both read, both decide they were newer than
           -- what they saw, and then write in either order -- so a refund
           -- delivered by webhook could be overwritten seconds later by the
           -- pre-refund figures a reconciliation page had already fetched. As a
           -- condition on the conflicting update it is evaluated while the row
           -- is locked, so the older write simply does not apply.
           --
           -- Equal timestamps still write, because replaying the same payload
           -- must remain possible.
           WHERE EXCLUDED.shopify_updated_at >= sd_orders.shopify_updated_at
           RETURNING id, customer_id`,
          [shop.id, o.id, o.name, orderNumber(o.name),
           linkedCustomer, new Date(o.createdAt), o.processedAt ?? null,
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

        /* No row means the guard refused this payload: what is stored is newer.
           Nothing else on the order is written either -- line items and refunds
           from a stale payload are stale too, and applying them would undo by
           the side door exactly what the guard just prevented. */
        if (!row) return { written: false, customerId: null };

        /* The order's customer, whether or not this payload carried one.
         *
         * `hydrate` deliberately omits the customer fields to avoid the
         * protected-data denial that already affects the backfill, so
         * `o.customer` is undefined on the webhook path and the block above
         * never ran. The set stayed empty, `refreshCustomerSpend` did nothing,
         * and every customer statistic waited for the fifteen-minute
         * reconciliation -- or forever, if hydration had failed, since it is
         * best-effort by design.
         *
         * Reading the link back off the row covers both cases. */

        /* Omitted is not the same as empty.
        
           A missing field is a payload with no opinion about line items, and
           whatever is stored stays. A present list carries current figures for
           the lines it names, and those are always written.
          
           Whether the lines it does NOT name should be deleted is a separate
           question, decided just below -- the two were tangled together before,
           which is how a truncated list came to delete real rows. */
        const lines: any[] | null = Array.isArray(o.lineItems?.nodes) ? o.lineItems.nodes : null;
        if (lines) {
          /* Whether this list may be pruned against.
          
             Writing the lines we were given is always right -- they are the
             current figures for the lines they describe. Deleting the ones that
             are absent is only right if their absence means removal, and there
             are two ways it does not.
          
             Truncation: the read asks for a hundred line items and does not
             receive a count. An order with more returns the first hundred and
             looks exactly like a complete list, so the prune deleted the rest
             on every pass -- and the bulk import, which has no such limit,
             writes all of them, so the two paths quietly fought.
          
             Emptiness: an empty array is not evidence. A Shopify order always
             carries at least one line, and an edit that removes everything
             leaves lines at quantity zero rather than none; meanwhile the bulk
             reassembly hands every order `nodes: []` by default, so an export
             whose tail was lost presents real orders as having no lines at all.
             Treating that as authoritative deletes them.
          
             So: prune only on a list that is non-empty and known complete.
             Being wrong this way leaves a stale line until the next sync that
             can see the whole order. Being wrong the other way destroys rows
             Shopify still has. */
          const truncated = o.lineItems?.pageInfo?.hasNextPage === true;
          const prunable = lines.length > 0 && !truncated;

          const seen: string[] = [];
          for (const li of lines) {
            seen.push(li.id);
            await c.query(
              `INSERT INTO sd_order_line_items (order_id, shopify_gid, product_gid, variant_gid,
                  title, variant_title, sku, quantity, current_quantity, original_total, discounted_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (shopify_gid) DO UPDATE SET
                 -- Corrected and pruned, not merely inserted. DO NOTHING froze
                 -- an edited line at its original figures and left a removed
                 -- line in the mirror for ever; order edits are ordinary on a
                 -- florist's orders, where a customer rings to change an
                 -- arrangement.
                 order_id = EXCLUDED.order_id,
                 quantity = EXCLUDED.quantity,
                 current_quantity = EXCLUDED.current_quantity,
                 original_total = EXCLUDED.original_total,
                 discounted_total = EXCLUDED.discounted_total,
                 product_gid = EXCLUDED.product_gid, variant_gid = EXCLUDED.variant_gid,
                 sku = EXCLUDED.sku,
                 title = EXCLUDED.title, variant_title = EXCLUDED.variant_title`,
              [row.id, li.id, li.product?.id ?? null, li.variant?.id ?? null,
               li.title, li.variant?.title ?? null, li.sku ?? null,
               li.quantity ?? 0, li.currentQuantity ?? li.quantity ?? 0,
               shopMoney(li.originalTotalSet), shopMoney(li.discountedTotalSet)]);
          }
          // Anything on the order here that Shopify no longer lists was removed.
          if (prunable) {
            await c.query(
              `DELETE FROM sd_order_line_items
                WHERE order_id = $1 AND NOT (shopify_gid = ANY($2::text[]))`, [row.id, seen]);
          }
        }

        /* Refunds likewise: an amount can be adjusted after the fact, and
           DO NOTHING froze whatever arrived first. Not pruned, though -- a refund
           is not un-issued, and `refunds/create` may deliver one the order query
           has not caught up with yet, so absence here does not mean removal.
        
           Repeating the same refund is a no-op by construction: the conflict is
           on Shopify's own refund id and the update is an assignment, not an
           increment, so the row converges on the delivered amount however many
           times it arrives. */
        for (const rf of o.refunds ?? []) {
          await c.query(
            `INSERT INTO sd_refunds (order_id, shopify_gid, total_refunded, shopify_created_at)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (shopify_gid) DO UPDATE SET
               order_id = EXCLUDED.order_id,
               total_refunded = EXCLUDED.total_refunded`,
            [row.id, rf.id, shopMoney(rf.totalRefundedSet), rf.createdAt]);
        }

        return { written: true, customerId: (row.customer_id as string | null) ?? null };
      });

      /* Counted outside the transaction, so an order rolled back by an error
         contributes neither to the tally nor to the customers recomputed, and a
         payload the guard refused counts as what it is: nothing written. */
      if (!applied.written) continue;
      if (applied.customerId) touchedCustomers.add(applied.customerId);
      n++;
    }

    /* Recomputed from the orders now committed, not accumulated as we went.
    
       Safe to repeat by construction: it is a SELECT over the customer's own
       orders assigned into the columns, so the same batch applied twice gives
       the same answer, and a cancellation brings the figures down -- which an
       accumulator could never do. */
    await this.refreshCustomerSpend([...touchedCustomers]);

    /* Customers are kept current as a consequence of syncing orders -- there is
       no separate customer pull -- and nothing was marking the resource. The
       Data & Sync screen therefore reported customers as permanently behind,
       on a row that had never once been stamped since the seed created it.
    
       Marked here rather than given a job of its own, because that is the
       truth: a customer is current because the orders that touched them are. */
    if (touchedCustomers.size) {
      await this.markSync('customers', touchedCustomers.size);
    }

    return n;
  }

  /**
   * Initial load, and any large historical pull.
   *
   * Starts a bulk
   * operation and waits for it -- which used to be a lie: the live source threw
   * "Live order paging runs through BackfillService, not here" and no such
   * service existed, so the initial sync simply did not work.
   */
  async backfill(since?: string): Promise<number> {
    if (this.shopify.source.kind !== 'live') {
      const orders = await this.shopify.source.orders();
      return this.upsertOrders(orders);
    }

    const shop = await this.shops.get();

    /* One import at a time, decided by the database.
    
       Two backfills running together is not merely wasteful: each starts its
       own bulk operation, and Shopify allows one per shop -- so the second
       cancels the first, and the first then streams a result its operation no
       longer owns. A process-local flag cannot prevent that, because the two
       callers are usually two processes: the API and the worker, or two API
       instances behind the load balancer.
    
       The claim is one conditional UPDATE. The thirty-minute escape is what
       stops a crashed import blocking every future one: a RUNNING row whose
       last_run_at has not moved in half an hour belonged to a process that is
       no longer running. */
    const claimed = await one<any>(
      `INSERT INTO sd_sync_state (shop_id, resource, status, last_run_at, records)
       VALUES ($1, 'orders_backfill', 'RUNNING', now(), 0)
       ON CONFLICT (shop_id, resource) DO UPDATE
         SET status = 'RUNNING', last_run_at = now(), error = NULL
       WHERE sd_sync_state.status <> 'RUNNING'
          OR sd_sync_state.last_run_at < now() - interval '30 minutes'
       RETURNING progress`,
      [shop.id]);

    if (!claimed) {
      throw new ConflictException(
        'A backfill is already running for this shop. Wait for it to finish, or retry in half an hour if the one holding it has died.');
    }

    /* Where the last attempt got to, if it was interrupted.
    
       Resuming matters because an import is minutes of streaming and tens of
       thousands of writes; beginning again from the first order after a deploy
       restarted the process is an expensive way to arrive at the same place.
       The write path is idempotent, so resuming is an optimisation rather than
       a correctness mechanism -- which is the reason it is safe to be
       approximate about it. */
    const prior = claimed.progress as any | null;
    const resumable = prior?.operationId && prior?.phase === 'streaming';

    let operationId: string;
    let skipLines = 0;

    if (resumable && await this.backfills.stillAvailable(prior.operationId)) {
      operationId = prior.operationId;
      skipLines = Number(prior.linesProcessed ?? 0);
      this.log.warn(
        `resuming interrupted backfill ${operationId} after ${skipLines} line(s)`);
    } else {
      if (resumable) {
        /* The operation is gone -- results expire, and a newer operation
           replaces an older one. There is nothing to resume from, so say so
           rather than silently starting over as if this were a fresh import. */
        this.log.warn(
          `cannot resume backfill ${prior.operationId}: the export is no longer available. Starting a new one.`);
      }
      const started = await this.backfills.start(since);
      if (started.note) this.log.warn(started.note);
      operationId = started.operationId;
    }

    const saveProgress = async (p: any) => {
      await query(
        `UPDATE sd_sync_state SET progress = $2::jsonb, last_run_at = now(), records = $3
          WHERE shop_id = $1 AND resource = 'orders_backfill'`,
        [shop.id, JSON.stringify({ ...p, phase: 'streaming', startedAt: prior?.startedAt ?? new Date() }),
         p.written ?? 0]);
    };
    await saveProgress({ operationId, linesProcessed: skipLines, written: 0 });

    try {
      const result = await this.backfills.waitAndIngest(
        operationId, (orders) => this.upsertOrders(orders),
        {
          skipLines,
          /* Written after every batch, not at the end. The whole point is that
             an import killed in the middle leaves a record of how far it got. */
          onProgress: (p) => saveProgress({
            operationId: p.operationId, url: p.url, objectCount: p.objectCount,
            linesProcessed: p.lines + skipLines, orders: p.orders, written: p.written,
          }),
        });

      this.log.log(`backfill ingested ${result.orders} orders from ${result.objectCount} objects`);
      if (result.note) this.log.warn(`backfill: ${result.note}`);

      /* Success is recorded only here -- after the stream finished, after every
         batch was written, and after the line count was checked against the
         export's own object count. Anything short of that leaves the row
         RUNNING or ERROR with its progress intact. */
      await query(
        `UPDATE sd_sync_state
            SET status = 'OK', last_ok_at = now(), last_run_at = now(),
                records = $2, error = NULL, progress = NULL
          WHERE shop_id = $1 AND resource = 'orders_backfill'`,
        [shop.id, result.orders]);

      return result.orders;
    } catch (e: any) {
      /* The progress column is deliberately left alone: it is what the next
         attempt resumes from. Only the status and the message change. */
      await query(
        `UPDATE sd_sync_state SET status = 'ERROR', error = $2, last_run_at = now()
          WHERE shop_id = $1 AND resource = 'orders_backfill'`,
        [shop.id, String(e?.message ?? e).slice(0, 500)]);
      throw e;
    }
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
      return { created: [], existing: [], skipped: 'Shopify source is not live' };
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
        const message = errs.map((e: any) => e.message).join('; ');

        /* Stop on a rejection that is about the address rather than the topic.
        
           Shopify validates the callback URL on every create, so an address it
           will not accept fails identically fifteen times -- fifteen warnings
           saying the same thing, which buries whichever one was different. The
           first is the whole story, and continuing serves no purpose. */
        if (/domain|address|url|https/i.test(message)) {
          this.log.error(
            `Shopify rejected the webhook address "${callbackUrl}": ${message}. ` +
            `No subscriptions were created. Check SHOPIFY_WEBHOOK_BASE_URL — it ` +
            `must be a public HTTPS hostname, and the API must be restarted ` +
            `after changing it.`);
          await this.markSync('webhooks', 0, message);
          return { created, existing, skipped: message };
        }

        this.log.warn(`${enumName}: ${message}`);
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
   * These used to come from a captured fixture, which was fine while the
   * capture and the store were the same shop. Point the app at a different
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

  /** Shopify's own order count, for deciding whether the mirror is complete.
   *  Null when it cannot be asked, so the caller can tell "no" from "unknown". */
  async shopifyOrderCount(): Promise<number | null> {
    if (this.shopify.source.kind !== 'live') return null;
    const d = await this.shopify.source.graphql<any>('{ ordersCount { count } }');
    const n = d?.ordersCount?.count;
    return typeof n === 'number' ? n : null;
  }

  /** Record that the history is present without re-importing it -- for an
   *  install that backfilled before the dedicated row existed. */
  async markBackfilled(count: number): Promise<void> {
    await this.markSync('orders_backfill', count);
  }

  /** Public entry point for the detached runner above. */
  startLongJob(resource: string, label: string, job: () => Promise<number>) {
    return this.startDetached(resource, label, job);
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
    const state = await one<any>(
      `SELECT watermark, resume_cursor, resume_since
         FROM sd_sync_state WHERE shop_id = $1 AND resource = 'orders'`,
      [shop.id]);



    /* Stamped before the plan is made, and reused as the run's clock: the
       watermark a finished run lands on must not be later than the moment its
       first request went out. */
    const runStartedAt = new Date();
    const { since, startCursor, resuming } = resumePlan(state, runStartedAt);
    if (resuming) {
      this.log.log(`reconcile: resuming an unfinished run from ${since.toISOString()}`);
    }

    const filter = `updated_at:>=${since.toISOString()}`;

    const source = this.shopify.source;
    const result = await paginateOrders({
      maxPages: RECONCILE_MAX_PAGES,
      startCursor,
      fetchPage: async (cursor) => {
        const data: any = await source.graphql<any>(
          `query($q: String!, $after: String) {
             orders(first: ${RECONCILE_PAGE_SIZE}, query: $q, after: $after, sortKey: UPDATED_AT) {
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
                 lineItems(first: 100) {
                   # Whether a hundred is all of them. Without it a truncated
                   # list is indistinguishable from a complete one, and the
                   # prune below deletes every line past the hundredth -- on
                   # every pass, for ever.
                   pageInfo { hasNextPage }
                   nodes {
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
        return {
          nodes: conn?.nodes ?? [],
          hasNextPage: !!conn?.pageInfo?.hasNextPage,
          endCursor: conn?.pageInfo?.endCursor ?? null,
        };
      },
      writePage: (nodes) => this.upsertOrders(nodes),
    });

    const { seen, written, complete, failure } = result;
    const watermark = nextWatermark(result, runStartedAt);
    const resume = nextResume(result, since);

    if (complete) {
      this.log.log(
        `reconcile: ${seen} orders changed since ${since.toISOString()}, ${written} written`);
    } else if (failure) {
      this.log.error(
        `reconcile: failed after ${result.pages} page(s), ${written} written; `
        + `${resume.cursor ? 'resuming from the last written page' : 'retrying from the watermark'}`
        + ` -- ${failure.message}`);
    } else {
      /* Neither success nor failure: the ceiling stopped the run with pages
         still behind it. Saying so is the point -- this used to be
         indistinguishable from finishing, and the watermark moved to now(),
         which is how changes were lost rather than merely delayed. */
      this.log.warn(
          `reconcile: stopped at the ${result.pages}-page ceiling with more to fetch; `
          + `${seen} seen, ${written} written; the next run resumes from this point`);
    }

    /* The watermark moves only when a run reached the end of its results, and
       then to the instant it began. An unfinished run leaves it untouched and
       records its cursor instead, which is how a backlog drains without the
       window ever covering work that was not fetched. */
    await this.markSync('orders', written, failure?.message, watermark, resume);

    /* The scheduler counts a throw as a failed job and backs off; an unfinished
       run is neither, and it has just made progress worth coming back for. */
    if (failure) throw failure;
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

  /**
   * Start a long job, return immediately, report through `sd_sync_state`.
   *
   * A full store-credit export or an order backfill takes minutes. Held open as
   * an HTTP request, nginx gives up at its sixty-second proxy timeout and the
   * caller gets a 504 -- while the job carries on server-side, invisible. The
   * operator sees a failure that did not happen and presses the button again,
   * which starts a second copy of the same bulk export.
   *
   * Raising the nginx timeout would be the wrong fix: a request that takes ten
   * minutes is not a request, and no timeout is long enough for a backfill on a
   * store that keeps growing.
   *
   * So the resource is marked RUNNING, the job is detached, and the Data & Sync
   * screen -- which already polls every sixty seconds and already knows how to
   * render a `running` badge -- shows it happening. `markSync` writes the
   * outcome whether it succeeds or fails, so the row is never left claiming to
   * be running after the process has moved on.
   */
  private async startDetached(
    resource: string, label: string, job: () => Promise<number>,
  ): Promise<{ started: boolean; resource: string; message: string }> {
    const shop = await this.shops.get();

    /* Refuse a second copy. Two concurrent bulk exports of the same data
       achieve nothing except spending the rate-limit budget twice, and the
       double-press is the most likely way to get here given the 504 that
       prompted this. */
    const [state] = await query<{ status: string; last_run_at: Date | null }>(
      `SELECT status, last_run_at FROM sd_sync_state
        WHERE shop_id = $1 AND resource = $2`, [shop.id, resource]);

    if (state?.status === 'RUNNING') {
      const since = state.last_run_at ? new Date(state.last_run_at) : null;
      /* Unless it has been running implausibly long, in which case the process
         was restarted mid-job and the row is stale rather than accurate. */
      const stuck = since ? Date.now() - since.getTime() > 30 * 60_000 : true;
      if (!stuck) {
        return { started: false, resource,
                 message: `${label} is already running — watch the status below.` };
      }
      this.log.warn(`${resource} was left RUNNING since ${since?.toISOString()} — restarting it`);
    }

    await query(
      `INSERT INTO sd_sync_state (shop_id, resource, last_run_at, status)
       VALUES ($1,$2, now(), 'RUNNING')
       ON CONFLICT (shop_id, resource) DO UPDATE
         SET last_run_at = now(), status = 'RUNNING', error = NULL`,
      [shop.id, resource]);

    /* Deliberately not awaited. The catch is what keeps a failure from becoming
       an unhandled rejection, and what makes sure the row stops saying RUNNING. */
    void (async () => {
      try {
        const n = await job();
        await this.markSync(resource, n);
        this.log.log(`${label}: finished, ${n} records`);
      } catch (e: any) {
        const message = e?.message ?? String(e);
        await this.markSync(resource, 0, message).catch(() => undefined);
        this.log.error(`${label} failed: ${message}`);
      }
    })();

    return { started: true, resource,
             message: `${label} started. It runs in the background — watch the status below.` };
  }

  /**
   * Record a run.
   *
   * `watermark` is where sync progress should now stand. Omitted, it means
   * now(), which is right for a resource that either finishes or fails whole.
   * Reconciliation can also stop part-way, so it passes an explicit point --
   * or null to leave the watermark exactly where it was.
   *
   * An error always preserves the existing watermark, whatever is passed.
   */
  private async markSync(
    resource: string, records: number, error?: string, watermark?: Date | null,
    resume?: { cursor: string | null; since: Date | null },
  ) {
    const shop = await this.shops.get();
    const mark = watermark === undefined ? null : watermark;
    const explicit = watermark !== undefined;
    await query(
      `INSERT INTO sd_sync_state (shop_id, resource, watermark, last_run_at, last_ok_at, status, records, error,
                                  resume_cursor, resume_since)
       VALUES ($1,$2, CASE WHEN $4::text IS NOT NULL THEN NULL
                           WHEN $5::boolean THEN $6::timestamptz ELSE now() END,
               now(), CASE WHEN $4::text IS NULL THEN now() END,
               CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END, $3, $4,
               $7::text, $8::timestamptz)
       ON CONFLICT (shop_id, resource) DO UPDATE
         SET watermark = CASE
               WHEN $4::text IS NOT NULL THEN sd_sync_state.watermark
               WHEN $5::boolean THEN COALESCE($6::timestamptz, sd_sync_state.watermark)
               ELSE now() END,
             last_run_at = now(),
             last_ok_at = CASE WHEN $4::text IS NULL THEN now() ELSE sd_sync_state.last_ok_at END,
             status = CASE WHEN $4::text IS NULL THEN 'OK' ELSE 'ERROR' END,
             records = EXCLUDED.records, error = $4,
             /* Only reconciliation passes a resume point; every other resource
                leaves its columns exactly as they were. */
             resume_cursor = CASE WHEN $9::boolean THEN $7::text ELSE sd_sync_state.resume_cursor END,
             resume_since  = CASE WHEN $9::boolean THEN $8::timestamptz ELSE sd_sync_state.resume_since END`,
      [shop.id, resource, records, error ?? null, explicit, mark,
       resume?.cursor ?? null, resume?.since ?? null, resume !== undefined]);
  }

  /**
   * The events that have given up, for somebody to look at.
   *
   * Bounded by construction: a limit the caller cannot raise past 100, ordered
   * by the index that already exists. A dead-letter screen that tries to render
   * every failure a busy store has ever had is a screen nobody opens twice.
   *
   * The payload is deliberately NOT returned. It is a Shopify order: names,
   * addresses, phone numbers, line items. Deciding whether to replay an event
   * needs the topic, when it arrived, how many times it was tried and what the
   * error said -- none of which is customer data. Whether a payload still
   * exists is returned, because retention nulls it after ninety days and an
   * event without one cannot be replayed; the contents are not.
   */
  async failedEvents(limit = 50, offset = 0): Promise<FailedWebhookEventsResponse> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const rows = await query<any>(
      `SELECT id, topic, status, attempts, received_at, last_attempt_at,
              next_attempt_at, error, (payload IS NOT NULL) AS has_payload
         FROM sd_webhook_events
        WHERE status IN ('DEAD','FAILED')
        ORDER BY received_at DESC
        LIMIT $1 OFFSET $2`, [capped, Math.max(offset, 0)]);

    const total = await one<any>(
      `SELECT COUNT(*) AS n FROM sd_webhook_events WHERE status IN ('DEAD','FAILED')`);

    return {
      total: Number(total?.n ?? 0),
      events: rows.map((r) => ({
        id: r.id, topic: r.topic, status: r.status,
        attempts: r.attempts,
        receivedAt: new Date(r.received_at).toISOString(),
        lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at).toISOString() : null,
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
        error: r.error,
        hasPayload: r.has_payload,
      })),
    };
  }

  /**
   * Put a dead event back in the queue.
   *
   * It does not process anything itself. It returns the event to PENDING and
   * schedules it, and the worker claims it through exactly the same path as any
   * other event -- same lease, same ordering guard, same idempotent writes. A
   * replay that ran the payload directly would be a second processing path, and
   * a second path is where the two disagree about what "already applied" means.
   *
   * Only DEAD and FAILED can be replayed. PROCESSING belongs to a worker,
   * PENDING is already queued, and PROCESSED or STALE are finished -- replaying
   * those would either duplicate work or resurrect a decision already taken.
   *
   * The attempt count is reset so the event gets a full budget rather than
   * dying again on its first try. The error is kept: a replayed event that
   * fails the same way is far easier to recognise with the previous message
   * still beside it, and the history is the point of the screen.
   */
  async replayEvent(id: string): Promise<ReplayWebhookEventResponse> {
    const ev = await one<any>(
      `SELECT id, status, payload IS NOT NULL AS has_payload
         FROM sd_webhook_events WHERE id = $1`, [id]);
    if (!ev) throw new NotFoundException('No such webhook event.');

    if (!['DEAD', 'FAILED'].includes(ev.status)) {
      throw new BadRequestException(
        `This event is ${ev.status}. Only events that have failed or been given up on can be replayed.`);
    }
    if (!ev.has_payload) {
      /* Retention nulls the payload after ninety days. There is nothing left to
         apply, and saying so is better than queueing an event that will fail
         for a reason the screen does not explain. */
      throw new BadRequestException(
        'The payload for this event was cleared by retention, so there is nothing left to replay.');
    }

    const [queued] = await query<{ id: string }>(
      `UPDATE sd_webhook_events
          SET status = 'PENDING', attempts = 0, next_attempt_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, processed_at = NULL
        WHERE id = $1 AND status IN ('DEAD','FAILED')
        RETURNING id`, [id]);

    if (!queued) {
      // Something changed it between the read and the write.
      return { id, status: 'UNCHANGED', queued: false,
               note: 'The event changed state while this was being processed; nothing was done.' };
    }
    return { id, status: 'PENDING', queued: true };
  }

  async health(): Promise<SyncHealthResponse> {
    const shop = await this.shops.get();
    const resources = await query(
      `SELECT resource, watermark, last_run_at, last_ok_at, status, error, records
         FROM sd_sync_state WHERE shop_id = $1 ORDER BY resource`, [shop.id]);

    /* Every figure the queue panel shows, measured in one pass.
    
       It used to report `active: 0, failed: 0, completed: 0` -- literal zeros,
       beside a `waiting` read from the length of a Redis list. That list stopped
       being the queue when the worker began taking its work from PostgreSQL, so
       the one number that was not hardcoded was measuring the wrong thing. A
       health screen answering confidently and wrongly is worse than one that
       says nothing, because the wrong answer looks healthy.
    
       The window counts are bounded by received_at, which 0027 indexes;
       the state counts are over the live states only, which the Phase 3 partial
       indexes already cover. */
    const counts = await one<any>(
      `SELECT
         COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours')            AS received,
         COUNT(*) FILTER (WHERE status = 'STALE'
                            AND received_at > now() - interval '24 hours')            AS stale,
         COUNT(*) FILTER (WHERE status IN ('PROCESSED','STALE')
                            AND received_at > now() - interval '24 hours')            AS completed,
         COUNT(*) FILTER (WHERE status = 'PENDING')                                   AS waiting,
         COUNT(*) FILTER (WHERE status = 'PROCESSING')                                AS processing,
         COUNT(*) FILTER (WHERE status = 'FAILED')                                    AS retrying,
         COUNT(*) FILTER (WHERE status = 'DEAD')                                      AS dead,
         COUNT(*) FILTER (WHERE status = 'PROCESSING'
                            AND lease_expires_at <= now())                            AS expired_leases,
         /* How far behind the queue is, in the only terms that matter: how long
            the oldest piece of due work has been waiting. A backlog of ten
            events that arrived a minute ago is fine; one event stuck for six
            hours is not, and a count alone cannot tell them apart. */
         EXTRACT(EPOCH FROM (now() - MIN(next_attempt_at) FILTER (
           WHERE status IN ('PENDING','FAILED')
             AND next_attempt_at IS NOT NULL
             AND next_attempt_at <= now())))::int                                     AS oldest_due_seconds
         FROM sd_webhook_events`);
    /* Redis is still where the duplicate counter and the last-checked stamp
       live, and neither is load-bearing -- so an outage costs two fields on a
       screen rather than the screen. It used to throw and take the whole health
       response with it. */
    let dupes = 0, lastCheck: string | null = null;
    try {
      dupes = parseInt((await redis().get('sales:webhooks:dupes24h')) || '0', 10);
      lastCheck = await redis().get('sales:webhooks:lastCheck');
    } catch (e: any) {
      this.log.warn(`health: Redis unavailable for webhook counters: ${e?.message ?? e}`);
    }

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
          //
          // Judged against each resource's own cadence. One blanket
          // twenty-four-hour threshold was wrong in a way that matters: it put
          // orders_backfill permanently in the red. That import is a one-time
          // load of the store's history -- it ran once, brought ninety-six
          // thousand orders, and is SUPPOSED to have an old timestamp. A row
          // that can only ever be red teaches people to ignore the colour, and
          // then the reconciliation row going red means nothing either.
          healthy: isResourceHealthy(r.resource, r.status, lag),
        };
      }),
      queue: {
        waiting: Number(counts.waiting),
        processing: Number(counts.processing),
        retrying: Number(counts.retrying),
        dead: Number(counts.dead),
        completed24h: Number(counts.completed),
        expiredLeases: Number(counts.expired_leases),
        oldestDueSeconds: counts.oldest_due_seconds === null
          ? null : Number(counts.oldest_due_seconds),
        maxAttempts: MAX_ATTEMPTS,
      },
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
    private audit: AuditService,
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
    return this.sync.startLongJob('orders_backfill', 'Order backfill',
      () => this.sync.backfill(body?.since));
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
  /**
   * The events that have given up.
   *
   * On the sync admin controller, behind the permission that already guards
   * everything else here -- a new one would be a second thing to grant and
   * forget, for a screen whose audience is exactly the people who can already
   * trigger a backfill.
   */
  @Get('failed-events')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  failedEvents(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.sync.failedEvents(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0);
  }

  /**
   * Put one back in the queue.
   *
   * Audited, because it is a person reaching into the queue by hand: who did
   * it, to which event, and when. The audit trail is the only record that a
   * replay happened at all -- the event row itself ends up looking like any
   * other processed event.
   */
  @Post('failed-events/:id/replay')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async replayEvent(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.sync.replayEvent(id);
    await this.audit.write({
      actorId: principal.id,
      moduleKey: 'sales',
      action: 'sales.webhook.replay',
      entityType: 'sd_webhook_events',
      entityId: id,
      payload: { queued: result.queued, status: result.status },
    });
    return result;
  }

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
  async storeCredit() {
    return this.sync.startLongJob('store_credit', 'Store credit export',
      () => this.credit.sync());
  }

  @Post('abandoned')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async abandoned() {
    return this.sync.startLongJob('abandoned_checkouts', 'Abandoned checkout pull',
      () => this.abandonedCheckouts.sync());
  }

  @Post('reconcile')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async reconcile() { return { orders: await this.sync.reconcile() }; }

  /** Fill hour-grain history so day comparisons read from the store rather than
   *  calling Shopify. Run once; the nightly job keeps the recent fortnight. */
  @Post('snapshots/hourly-backfill')
  @Permissions(PERMISSIONS.SYNC_MANAGE)
  async hourlyBackfill(@Body() body: { months?: number } = {}) {
    return this.sync.startLongJob('hourly_backfill', 'Hourly history fill',
      () => this.snapshots.backfillHourly(body?.months ?? 13));
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
/**
 * How long each resource may go without a success before it is worth saying so.
 *
 * Different jobs, different clocks:
 *
 *   orders            reconciliation every fifteen minutes. An hour without a
 *                     success means something is actually wrong.
 *   customers         written as a consequence of orders syncing, so it tracks
 *                     order traffic. A whole quiet day is possible on a slow
 *                     weekend; two is not.
 *   webhooks          re-verified by the watchdog at 03:00 Cairo. A day and a
 *                     bit covers the gap between runs without flapping red in
 *                     the hours before each one.
 *   orders_backfill   a one-time import of the store's whole history. It has
 *                     no cadence at all, so age says nothing about it. Only a
 *                     failure or a never-run state is worth reporting.
 */
const RESOURCE_MAX_LAG_SECONDS: Record<string, number | null> = {
  orders: 60 * 60,
  customers: 36 * 60 * 60,
  webhooks: 26 * 60 * 60,
  orders_backfill: null,        // never stale by age
};

/** Anything not listed keeps the old blanket day. */
const DEFAULT_MAX_LAG_SECONDS = 24 * 60 * 60;

export function isResourceHealthy(
  resource: string, status: string, lagSeconds: number | null,
): boolean {
  if (status !== 'OK') return false;
  // Never completed: not healthy whatever its cadence.
  if (lagSeconds === null) return false;

  const max = resource in RESOURCE_MAX_LAG_SECONDS
    ? RESOURCE_MAX_LAG_SECONDS[resource]
    : DEFAULT_MAX_LAG_SECONDS;

  // null means age is not a signal for this resource -- it succeeded, and that
  // is the whole question.
  if (max === null) return true;
  return lagSeconds < max;
}