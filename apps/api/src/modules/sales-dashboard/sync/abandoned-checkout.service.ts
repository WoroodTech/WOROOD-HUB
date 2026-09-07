/**
 * Abandoned checkouts: carts and checkouts that were started and not finished.
 *
 * Two things make this different from the order mirror, and both shape the code
 * below.
 *
 * **A checkout is only "abandoned" once contact details were entered.** That is
 * Shopify's definition, and it is what makes this table worth having: every row
 * is someone reachable, with a recovery URL Shopify generates. It is the only
 * dataset in the module that customer care can *act* on rather than read.
 *
 * **Abandonment is not one event.** Shopify tracks it at three points --
 * browsing, adding to cart, and reaching checkout -- and they mean different
 * things. Someone who filled in an address and stopped at payment is a phone
 * call worth making; someone who looked at a product and left is not. The
 * `abandonedCheckouts` query returns the third kind only, which is why `stage`
 * defaults to CHECKOUT and exists for the other two rather than pretending they
 * are the same.
 *
 * Recovery is what makes the numbers mean anything. Shopify returns abandoned
 * and recovered checkouts from the same query, distinguished by `completedAt`,
 * so the recovery rate is available without a second source -- and it is the
 * figure that says whether anyone is acting on the list.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { one, query } from '../../../common/db';
import { ShopContext, type Shop } from '../analytics/snapshot.service';
import { ShopifyService } from '../shopify/shopify.service';

/**
 * Confirmed against the live schema by introspection rather than taken from the
 * documentation, after a first attempt was rejected for four reasons at once.
 *
 * Three of them are worth writing down, because each is a reasonable guess that
 * happens to be wrong. `email` and `phone` are not on the checkout -- they hang
 * off `customer`, which also means a checkout with contact details but no
 * customer record carries them nowhere else. There is no `lineItemsQuantity`;
 * `lineItems` is a connection and the count has to be asked for as one. And
 * `AbandonedCheckoutSortKeys` has no `UPDATED_AT` -- see the sync below, which
 * is built around that absence.
 */
const CHECKOUT_FIELDS = `
  id name createdAt updatedAt completedAt abandonedCheckoutUrl
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) { nodes { id quantity } }
  customer { id displayName email phone }
  shippingAddress { firstName lastName city country }
  billingAddress  { firstName lastName city country }
`;

@Injectable()
export class AbandonedCheckoutService {
  private readonly log = new Logger('AbandonedCheckouts');

  constructor(
    private shops: ShopContext,
    private shopify: ShopifyService,
  ) {}

  /* ------------------------------------------------------------------ sync -- */

  /**
   * Pull everything updated since the last successful run.
   *
   * Its own watermark, deliberately. Sharing the orders watermark would mean a
   * failure here rolls it back and re-fetches ninety thousand orders next
   * cycle -- an expensive way to retry a cheap query.
   *
   * The five-minute overlap is the same trick reconciliation uses: a checkout
   * updated in the same second the previous run read the clock would otherwise
   * fall between two passes and never be seen.
   */
  async sync(): Promise<number> {
    if (this.shopify.source.kind !== 'live') return 0;

    const shop = await this.shops.get();
    const state = await one(
      `SELECT watermark FROM sd_sync_state
        WHERE shop_id = $1 AND resource = 'abandoned_checkouts'`, [shop.id]);

    /* First run takes thirty days rather than all history. An abandoned
       checkout from last year is not a lead, and Shopify's own recovery emails
       stop long before that -- pulling years of them would fill the table with
       rows nobody will ever call. */
    /* Windowed by creation, not by update -- because Shopify does not offer the
     * choice. `AbandonedCheckoutSortKeys` has no UPDATED_AT, so there is no way
     * to walk the ones that changed since the last run.
     *
     * That matters for one case: a checkout created three weeks ago and
     * completed today. Ordering by creation would never revisit it, and the
     * recovery would be missed. So the window always reaches back thirty days
     * from now rather than forward from a watermark. It re-reads the same rows
     * every cycle, which is cheap at this volume and is the only way recovery
     * stays correct.
     *
     * The watermark is still recorded, for the sync screen -- it says when this
     * last succeeded, not where to resume from.
     */
    void state;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    let cursor: string | null = null;
    let seen = 0;

    for (let page = 0; page < 40; page++) {
      const data: any = await this.shopify.source.graphql<any>(
        `query($q: String!, $after: String) {
           abandonedCheckouts(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
             pageInfo { hasNextPage endCursor }
             nodes { ${CHECKOUT_FIELDS} }
           }
         }`,
        { q: `created_at:>=${since.toISOString()}`, after: cursor });

      const conn = data?.abandonedCheckouts;
      const nodes = conn?.nodes ?? [];
      for (const node of nodes) await this.upsert(shop, node);
      seen += nodes.length;

      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }

    await query(
      `UPDATE sd_sync_state
          SET watermark = now(), last_run_at = now(), last_ok_at = now(),
              status = 'OK', records = $2
        WHERE shop_id = $1 AND resource = 'abandoned_checkouts'`, [shop.id, seen]);

    this.log.log(`abandoned checkouts: ${seen} since ${since.toISOString()}`);
    return seen;
  }

  private async upsert(shop: Shop, c: any): Promise<void> {
    const addr = c.shippingAddress ?? c.billingAddress ?? {};
    /* The address name first, the customer's second. On an abandoned checkout
       the address is often filled in before an account exists, so it is the
       more reliable of the two -- and when both are absent the row still has a
       value and an age, which is enough to size the opportunity. */
    const name = [addr.firstName, addr.lastName].filter(Boolean).join(' ')
      || c.customer?.displayName
      || null;

    /* Linked to a customer record when one exists, and perfectly usable when it
       does not -- an abandoned checkout frequently has contact details and no
       account, which is exactly the row customer care most wants. The contact
       columns are denormalised for that reason rather than read through the
       join. */
    const customer = c.customer?.id
      ? await one(`SELECT id FROM sd_customers WHERE shopify_gid = $1`, [c.customer.id])
      : null;

    await query(
      `INSERT INTO sd_abandoned_checkouts
         (shop_id, shopify_gid, stage, shopify_created_at, shopify_updated_at,
          completed_at, customer_id, total_price, currency_code, line_item_count,
          contact_email, contact_phone, contact_name, ship_city, ship_country, recovery_url)
       VALUES ($1,$2,'CHECKOUT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (shopify_gid) DO UPDATE SET
         shopify_updated_at = EXCLUDED.shopify_updated_at,
         -- The field that turns an abandonment into a recovery. Never unset it:
         -- a later edit to a completed checkout must not make it look open again.
         completed_at = COALESCE(sd_abandoned_checkouts.completed_at, EXCLUDED.completed_at),
         total_price = EXCLUDED.total_price,
         line_item_count = EXCLUDED.line_item_count,
         customer_id = COALESCE(EXCLUDED.customer_id, sd_abandoned_checkouts.customer_id),
         recovery_url = EXCLUDED.recovery_url
       -- The ordering guard the order mirror has had from the start, applied
       -- here too. Shopify guarantees no ordering within or across topics, so a
       -- checkouts/update delivered late can carry an older state than the row
       -- already holds. Without this, a stale delivery quietly reverts a value
       -- and nothing in the mirror records that it happened.
       WHERE EXCLUDED.shopify_updated_at IS NULL
          OR sd_abandoned_checkouts.shopify_updated_at IS NULL
          OR EXCLUDED.shopify_updated_at >= sd_abandoned_checkouts.shopify_updated_at`,
      [shop.id, c.id, c.createdAt, c.updatedAt ?? null, c.completedAt ?? null,
       customer?.id ?? null,
       Number(c.totalPriceSet?.shopMoney?.amount ?? 0),
       c.totalPriceSet?.shopMoney?.currencyCode ?? shop.currency_code,
       /* Items in the cart, summed across lines: two of one thing and one of
          another is three items, which is what "3 items" means to whoever
          reads the row. Fifty lines is the ceiling and is not a real limit --
          a cart with more distinct products than that is not a lead, it is a
          bug somewhere else. */
       (c.lineItems?.nodes ?? []).reduce(
         (sum: number, li: any) => sum + Number(li.quantity ?? 1), 0),
       c.customer?.email ?? null, c.customer?.phone ?? null, name,
       addr.city ?? null, addr.country ?? null,
       c.abandonedCheckoutUrl ?? null]);
  }

  /* ----------------------------------------------------------------- reads -- */

  /** Headline figures for a range: how many were abandoned, how many came back,
   *  and what each is worth. */
  async totals(shop: Shop, start: Date, end: Date) {
    const [row] = await query<any>(
      `SELECT COUNT(*)                                             AS abandoned,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL)      AS recovered,
              COALESCE(SUM(total_price), 0)                         AS value,
              COALESCE(SUM(total_price) FILTER (
                WHERE completed_at IS NOT NULL), 0)                 AS recovered_value,
              COALESCE(AVG(total_price), 0)                         AS average
         FROM sd_abandoned_checkouts
        WHERE shop_id = $1 AND shopify_created_at >= $2 AND shopify_created_at <= $3`,
      [shop.id, start, end]);

    const abandoned = Number(row?.abandoned ?? 0);
    const recovered = Number(row?.recovered ?? 0);
    return {
      abandoned, recovered,
      /* Of everything abandoned, the share that came back. Not "of everything
         we emailed" -- Shopify does not tell us who was contacted, so a
         recovery rate here includes people who returned on their own. It is
         still the number that moves when someone works the list. */
      recoveryRate: abandoned ? recovered / abandoned : 0,
      value: Number(row?.value ?? 0),
      recoveredValue: Number(row?.recovered_value ?? 0),
      /* What is still sitting there uncollected. The reason this dashboard
         exists rather than a report nobody opens. */
      openValue: Number(row?.value ?? 0) - Number(row?.recovered_value ?? 0),
      average: Number(row?.average ?? 0),
    };
  }

  /** Abandonment and recovery per bucket, for the trend. */
  async series(shop: Shop, start: Date, end: Date, grain: 'hour' | 'day') {
    return query<any>(
      `SELECT date_trunc($4, shopify_created_at AT TIME ZONE $5) AS bucket,
              COUNT(*)                                        AS abandoned,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS recovered
         FROM sd_abandoned_checkouts
        WHERE shop_id = $1 AND shopify_created_at >= $2 AND shopify_created_at <= $3
        GROUP BY 1 ORDER BY 1`,
      [shop.id, start, end, grain, shop.iana_timezone]);
  }

  /**
   * The working list: open checkouts, newest first, with a recovery link.
   *
   * Contact details are omitted rather than blanked when the caller lacks
   * `sales.customer.view`, so a client cannot reveal them by inspecting the
   * payload. Without the permission the row still shows its value and age --
   * enough to size the opportunity, not enough to call anyone.
   */
  async openList(shop: Shop, showContact: boolean, limit = 20) {
    const rows = await query<any>(
      `SELECT shopify_created_at, total_price, line_item_count,
              contact_name, contact_email, contact_phone, ship_city, recovery_url
         FROM sd_abandoned_checkouts
        WHERE shop_id = $1 AND completed_at IS NULL
        ORDER BY shopify_created_at DESC
        LIMIT $2`, [shop.id, limit]);

    return rows.map((r) => ({
      abandonedAt: r.shopify_created_at,
      value: Number(r.total_price ?? 0),
      items: Number(r.line_item_count ?? 0),
      ...(showContact
        ? {
            customer: r.contact_name ?? r.contact_email ?? '—',
            phone: r.contact_phone ?? '—',
            city: r.ship_city ?? '—',
            recover: r.recovery_url ?? null,
          }
        : {}),
    }));
  }

  /** How long ago the open ones were abandoned. A checkout abandoned an hour
   *  ago is a different conversation from one abandoned last week, and the
   *  distribution says how quickly anyone is getting to them. */
  async ageBuckets(shop: Shop) {
    const rows = await query<{ bucket: string; n: string; value: string }>(
      `SELECT CASE
                WHEN shopify_created_at > now() - interval '1 hour'  THEN 'Under an hour'
                WHEN shopify_created_at > now() - interval '1 day'   THEN 'Today'
                WHEN shopify_created_at > now() - interval '3 days'  THEN '1–3 days'
                WHEN shopify_created_at > now() - interval '7 days'  THEN '3–7 days'
                ELSE 'Over a week'
              END AS bucket,
              COUNT(*) AS n, COALESCE(SUM(total_price), 0) AS value
         FROM sd_abandoned_checkouts
        WHERE shop_id = $1 AND completed_at IS NULL
        GROUP BY 1`, [shop.id]);

    const ORDER = ['Under an hour', 'Today', '1–3 days', '3–7 days', 'Over a week'];
    return rows
      .map((r) => ({ label: r.bucket, value: Number(r.n), amount: Number(r.value) }))
      .sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label));
  }
}