/**
 * The initial sync: everything Shopify has, once, through a bulk operation.
 *
 * This is the half of the pipeline that never existed. `SyncService.backfill()`
 * called `source.orders()`, and the live implementation of that method threw
 * "Live order paging runs through BackfillService, not here" -- pointing at a
 * file that was not written. In fixture mode nobody noticed, because the
 * fixture source returned a captured slice and the dashboard filled up.
 *
 * Why a bulk operation rather than paged queries. Shopify prices every ordinary
 * GraphQL call against a leaky bucket, and a full order history is tens of
 * thousands of records; paging it would either take hours at 200 points a
 * second or trip the limiter constantly. Bulk operations are exempt from both
 * the calculated-cost limit and the thousand-point ceiling on a single query --
 * Shopify runs the query on its own side and hands back a file.
 *
 * The shape of that file is the thing worth knowing in advance. It is JSONL,
 * one JSON object per line, and nested connections are *flattened*: an order
 * and its line items are separate lines, and each child carries `__parentId`
 * pointing at its parent. Nothing arrives nested, and children may appear
 * before or after their parent. Reassembly is this file's real work.
 *
 * Two more details that are easy to discover the hard way. The result URL is
 * signed and expires after seven days, so it is downloaded promptly rather than
 * stored as a reference. And in the `bulk_operations/finish` webhook payload,
 * `status` and `error_code` arrive lowercase rather than in the GraphQL enum's
 * upper case.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { config } from '../../../common/config';
import { ShopifyService } from '../shopify/shopify.service';

/** Fields per order. Kept identical in shape to what `upsertOrders` reads, so
 *  an order written by the backfill and one written by a webhook are the same
 *  row -- the mirror must not be able to tell which door a record came in by. */
const ORDER_FIELDS = `
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
`;

/**
 * Customer identity and the shipping address, kept separate from the fields
 * above because they are Shopify's *protected customer data* and are governed
 * differently from everything else on an order.
 *
 * Holding `read_customers` is not sufficient. Protected customer data access
 * has to be granted to the app explicitly, and until it is, a bulk operation
 * that selects any of these fields does not fail when it is submitted -- it is
 * accepted, runs, and ends `FAILED / ACCESS_DENIED` minutes later. The whole
 * export is lost for four columns nobody was blocked on.
 *
 * So the backfill asks once, and on ACCESS_DENIED retries without them. Order
 * totals, line items and every headline figure survive; the customer columns
 * stay null until access is granted, and the next backfill fills them in.
 */
const CUSTOMER_FIELDS = `
  shippingAddress { city province country zip }
  customer { id displayName email phone numberOfOrders createdAt }
`;

const LINE_ITEM_FIELDS = `
  id title sku quantity currentQuantity
  product { id } variant { id title }
  originalTotalSet   { shopMoney { amount } }
  discountedTotalSet { shopMoney { amount } }
`;

export interface BackfillResult {
  operationId: string | null;
  objectCount: number;
  orders: number;
  status: string;
  note?: string;
}

@Injectable()
export class BackfillService {
  private readonly log = new Logger('BackfillService');

  /** Cleared for the process once Shopify refuses the protected fields, so a
   *  retry of a large export does not spend another few minutes rediscovering
   *  the same denial. Reset by a restart, which is also when access granted in
   *  the Dev Dashboard would take effect. */
  private includeCustomerFields = true;

  constructor(private shopify: ShopifyService) {}

  private buildQuery(filter: string, withCustomer: boolean): string {
    return `
      {
        orders${filter} {
          edges { node {
            ${ORDER_FIELDS}
            ${withCustomer ? CUSTOMER_FIELDS : ''}
            lineItems { edges { node { ${LINE_ITEM_FIELDS} } } }
          } }
        }
      }`;
  }

  /**
   * Start a bulk export and return immediately. Completion arrives either by
   * the `bulk_operations/finish` webhook or by `waitAndIngest` polling, so the
   * caller is never left holding an HTTP request open for several minutes.
   *
   * `since` narrows the export. Without `read_all_orders` Shopify serves only
   * the last sixty days regardless of what is asked for, and it does so
   * *silently* -- the query does not error, it simply returns fewer rows. That
   * is why the note below is returned rather than assumed away.
   */
  private lastSince?: string;

  async start(since?: string): Promise<{ operationId: string; note?: string }> {
    this.lastSince = since;
    if (this.shopify.source.kind !== 'live') {
      throw new Error('Backfill requires the live Shopify source; set SHOPIFY_TOKEN_STRATEGY');
    }

    const filter = since ? `(query: "updated_at:>=${since}")` : '';

    /* Refunds are deliberately not selected here.
     *
     * A bulk operation only accepts connections it can flatten, and Shopify
     * rejects the whole query -- not the offending field -- when it meets one
     * it will not export. Refunds on an order is such a field in some API
     * versions, and the refusal message names the field but costs a round trip
     * and a puzzled operator to read. Reconciliation carries refunds on the
     * paged path, so the mirror still gets them; the backfill's job is the bulk
     * of the history, not every last column of it. */
    const query = this.buildQuery(filter, this.includeCustomerFields);

    const data = await this.shopify.source.graphql<any>(
      `mutation($q: String!) {
         bulkOperationRunQuery(query: $q) {
           bulkOperation { id status }
           userErrors { field message }
         }
       }`, { q: query });

    const errs = data?.bulkOperationRunQuery?.userErrors ?? [];
    if (errs.length) {
      this.log.error(`bulkOperationRunQuery userErrors: ${JSON.stringify(errs)}`);
      /* The most common failure here is a second operation already running.
         Shopify allows up to five concurrent bulk *queries* per app as of
         2026-01, but only one per shop of the same kind, and the message says
         so plainly -- so it is passed through rather than flattened. */
      throw new Error(`bulkOperationRunQuery refused: ${errs.map((e: any) => e.message).join('; ')}`);
    }

    const op = data?.bulkOperationRunQuery?.bulkOperation;
    if (!op?.id) throw new Error('bulkOperationRunQuery returned no operation');

    this.log.log(`bulk operation ${op.id} started (${op.status})`);

    /* The sixty-day caveat, but only when it applies.
     *
     * This used to print unconditionally on any unbounded backfill, which was
     * accurate against an app holding only `read_orders` and actively
     * misleading against one that holds `read_all_orders` -- it warned that
     * history was being truncated in the same minute the export pulled 92,438
     * orders going back years. A caution that fires when it does not apply
     * teaches people to skip reading it.
     */
    const scopes = await this.grantedScopes();
    const truncated = scopes !== null && !scopes.includes('read_all_orders');

    return {
      operationId: op.id,
      note: since || !truncated ? undefined :
        'Without read_all_orders Shopify serves the last 60 days only, and does so silently.',
    };
  }

  /** What the app is actually granted, or null if it cannot be determined --
   *  in which case no claim is made either way. */
  private async grantedScopes(): Promise<string[] | null> {
    try {
      const data = await this.shopify.source.graphql<any>(
        `{ currentAppInstallation { accessScopes { handle } } }`);
      const scopes = data?.currentAppInstallation?.accessScopes;
      return Array.isArray(scopes) ? scopes.map((s: any) => s.handle) : null;
    } catch {
      return null;
    }
  }

  /** Poll until the operation leaves RUNNING, then ingest. `bulkOperation(id:)`
   *  is the current field; `currentBulkOperation` is deprecated. */
  async waitAndIngest(
    operationId: string,
    ingest: (orders: any[]) => Promise<number>,
    { timeoutMs = 15 * 60_000, intervalMs = 5_000 } = {},
  ): Promise<BackfillResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const data = await this.shopify.source.graphql<any>(
        `query($id: ID!) {
           node(id: $id) {
             ... on BulkOperation { id status errorCode objectCount url }
           }
         }`, { id: operationId });

      const op = data?.node;
      if (!op) throw new Error(`bulk operation ${operationId} not found`);

      if (op.status === 'COMPLETED') {
        if (!op.url) {
          // A completed operation with no URL means the query matched nothing.
          return { operationId, objectCount: 0, orders: 0, status: 'COMPLETED',
                   note: 'Shopify returned no rows for this range.' };
        }
        const orders = await this.download(op.url);
        const written = await ingest(orders);
        return {
          operationId, status: 'COMPLETED',
          objectCount: Number(op.objectCount ?? 0),
          orders: written,
        };
      }

      if (op.status !== 'RUNNING' && op.status !== 'CREATED') {
        if (op.errorCode === 'ACCESS_DENIED' && this.includeCustomerFields) {
          /* Almost always the protected customer fields. Drop them and go
             again rather than handing the operator a failure they cannot act
             on without knowing which of thirty fields Shopify objected to. */
          this.log.warn(
            'Bulk export denied. Retrying without customer identity and shipping ' +
            'address — these need protected customer data access, which is granted ' +
            'in the Dev Dashboard and is separate from the read_customers scope.');
          this.includeCustomerFields = false;
          const retry = await this.start(this.lastSince);
          return this.waitAndIngest(retry.operationId, ingest, { timeoutMs, intervalMs });
        }
        throw new Error(
          `bulk operation ${operationId} ended ${op.status}: ${op.errorCode ?? 'no error code'}`);
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`bulk operation ${operationId} did not finish within the timeout`);
  }

  /**
   * Download the JSONL and reassemble it.
   *
   * Streamed line by line rather than buffered: a full order history is
   * comfortably larger than anything worth holding in memory on a t4g, and the
   * whole point of the bulk path is that it copes with volume.
   *
   * Children can arrive before their parent, so nothing is attached on the
   * first pass -- orders are collected by id, orphans are held aside, and the
   * two are joined at the end. Attaching eagerly would silently drop any line
   * item Shopify happened to emit early.
   */
  private async download(url: string): Promise<any[]> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bulk result download failed: ${res.status}`);
    if (!res.body) return [];

    const orders = new Map<string, any>();
    const pendingLineItems = new Map<string, any[]>();
    const pendingRefunds = new Map<string, any[]>();

    const rl = createInterface({
      input: Readable.fromWeb(res.body as any),
      crlfDelay: Infinity,
    });

    let lines = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines++;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // One malformed line should not lose the other forty thousand.
        this.log.warn(`skipped an unparseable JSONL line at ${lines}`);
        continue;
      }

      const parent = obj.__parentId;
      if (!parent) {
        // A top-level object. Line items may already be waiting for it.
        obj.lineItems = { nodes: pendingLineItems.get(obj.id) ?? [] };
        obj.refunds = pendingRefunds.get(obj.id) ?? [];
        pendingLineItems.delete(obj.id);
        pendingRefunds.delete(obj.id);
        orders.set(obj.id, obj);
        continue;
      }

      /* A child. Refunds and line items are told apart by shape rather than by
         a type field, because the JSONL carries none: a refund line has
         totalRefundedSet, a line item has a quantity. */
      const isRefund = obj.totalRefundedSet !== undefined;
      const bucket = isRefund ? pendingRefunds : pendingLineItems;
      const target = orders.get(parent);

      if (target) {
        if (isRefund) target.refunds.push(obj);
        else target.lineItems.nodes.push(obj);
      } else {
        const held = bucket.get(parent) ?? [];
        held.push(obj);
        bucket.set(parent, held);
      }
    }

    const orphans = pendingLineItems.size + pendingRefunds.size;
    if (orphans) {
      // Not fatal, but it means the export and the reassembly disagree, and
      // that is worth seeing in the log rather than discovering in a total.
      this.log.warn(`${orphans} child rows had no parent in the export`);
    }

    this.log.log(`bulk result: ${lines} lines, ${orders.size} orders`);
    return [...orders.values()];
  }

  /** Called by the webhook handler when Shopify announces completion. The
   *  payload's `status` arrives lowercase, unlike the GraphQL enum. */
  isFinished(payload: any): boolean {
    return String(payload?.status ?? '').toUpperCase() === 'COMPLETED';
  }
}