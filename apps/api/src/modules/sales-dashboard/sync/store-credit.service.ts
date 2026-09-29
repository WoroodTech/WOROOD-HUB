/**
 * Store credit: what was issued, what was spent, what is still outstanding.
 *
 * There is no top-level query for store credit transactions. They hang off
 * `Customer → storeCreditAccounts → transactions`, which means finding them
 * requires walking customers -- and Worood has 37,484 of those.
 *
 * So this uses a bulk operation rather than paging. Bulk operations are exempt
 * from the calculated-cost limit, Shopify runs the query on its own side, and
 * the result comes back as JSONL with the connections flattened and children
 * carrying `__parentId` -- the same shape the order backfill reassembles.
 *
 * The alternative -- 37,484 paged customer queries, nearly all of which have no
 * store credit at all -- would spend the rate-limit budget for hours to find a
 * handful of rows. There is no way to ask Shopify for "customers with store
 * credit", so the choice is between exporting everyone once cheaply, or asking
 * about everyone expensively.
 *
 * This runs nightly rather than every fifteen minutes. Store credit moves when
 * a refund is issued as credit or a customer spends it -- events measured in
 * days, not minutes.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { one, query } from '../../../common/db';
import { ShopContext, type Shop } from '../analytics/snapshot.service';
import { ShopifyService } from '../shopify/shopify.service';

@Injectable()
export class StoreCreditService {
  private readonly log = new Logger('StoreCredit');

  constructor(
    private shops: ShopContext,
    private shopify: ShopifyService,
  ) {}

  /* ------------------------------------------------------------------ sync -- */

  /**
   * Transaction fields are selected on the `StoreCreditAccountTransaction`
   * interface rather than through per-type fragments.
   *
   * The interface has no `id`. Introspection said so plainly -- account,
   * amount, balanceAfterTransaction, createdAt, event, origin -- and it was
   * still asked for out of habit, which is what selecting fields from memory
   * gets you even with the answer on screen.
   *
   * That is not only a missing field, it removes the natural unique key. The
   * identity used instead is account plus timestamp plus amount, hashed: two
   * transactions on the same account, at the same instant, for the same amount
   * are indistinguishable to us and would be indistinguishable to anyone
   * reading the ledger. Shopify records transactions to the second, so a
   * genuine collision would need two identical movements inside one second on
   * one account.
   *
   * The first version listed `StoreCreditAccountCreditTransaction` and
   * `StoreCreditAccountDebitTransaction` and nothing else, so any other
   * implementation -- an expiry, an adjustment, whatever Shopify adds next --
   * came back as a JSONL line with no amount and was skipped in silence. One
   * customer's ledger summed to 200 against a Shopify balance of 300, and only
   * the stored `balanceAfterTransaction` made that visible.
   *
   * Introspection shows `amount`, `balanceAfterTransaction`, `createdAt`,
   * `event` and `origin` are fields of the interface itself, so asking there
   * catches every type including ones that do not exist yet. `__typename` is
   * what tells credit from debit.
   *
   * Note the query below is a string sent to Shopify, not TypeScript: GraphQL
   * comments start with `#`, and a `/* *\/` block inside it is a syntax error
   * Shopify reports as an unexpected token. Explanations belong out here.
   */
  async sync(): Promise<number> {
    if (this.shopify.source.kind !== 'live') return 0;
    const shop = await this.shops.get();

    const start = await this.shopify.source.graphql<any>(
      `mutation($q: String!) {
         bulkOperationRunQuery(query: $q) {
           bulkOperation { id status }
           userErrors { field message }
         }
       }`,
      { q: `
        {
          customers {
            edges { node {
              id
              storeCreditAccounts(first: 5) { edges { node {
                id
                balance { amount currencyCode }
                transactions(first: 250) { edges { node {
                  __typename createdAt event
                  amount { amount currencyCode }
                  balanceAfterTransaction { amount }
                } } }
              } } }
            } }
          }
        }` });

    const errs = start?.bulkOperationRunQuery?.userErrors ?? [];
    if (errs.length) {
      throw new Error(`store credit export refused: ${errs.map((e: any) => e.message).join('; ')}`);
    }
    const opId = start?.bulkOperationRunQuery?.bulkOperation?.id;
    if (!opId) throw new Error('store credit export returned no operation');

    const url = await this.waitFor(opId);
    if (!url) {
      this.log.log('store credit: nothing to export');
      await this.markSync(shop, 0);
      return 0;
    }

    const n = await this.ingest(shop, url);
    await this.markSync(shop, n);
    return n;
  }

  /**
   * Write one transaction. Shared by the nightly bulk export and the targeted
   * per-customer refresh, because two copies of this logic would be two places
   * to get the sign wrong -- and the sign has already been wrong once.
   *
   * The interface exposes no `id`, so identity is derived: account, timestamp,
   * amount and type, hashed. Deterministic, so re-exporting the same
   * transaction updates its row rather than duplicating it.
   */
  private async writeTransaction(
    shop: Shop, customerId: string, accountGid: string, t: any,
  ): Promise<void> {
    const syntheticGid = createHash('sha256')
      .update(`${accountGid}|${t.createdAt}|${t.amount?.amount}|${t.__typename}`)
      .digest('hex')
      .slice(0, 32);

    /* Every transaction arrives as a positive number, so the direction comes
       from the type. Four exist, and a Revert moves money the *opposite* way to
       the type it names:

         Credit         issued to the customer          +
         Debit          spent by the customer           −
         DebitRevert    a spend given back (a refund)   +
         CreditRevert   an issue taken back             −

       A plain `/Debit/` test reads DebitRevert as a debit, which is exactly
       backwards. One customer's ledger summed to 100 against a Shopify balance
       of 300: the refund was subtracted instead of added, a 200 swing on one
       row. The stored balanceAfterTransaction proved it -- the balance rose
       from 0 to 100 on a row recorded as -100. */
    const typeName = String(t.__typename ?? '');
    const isRevert = /Revert/i.test(typeName);
    const isDebit = /Debit/i.test(typeName) !== isRevert;   // XOR
    const raw = Math.abs(Number(t.amount?.amount ?? 0));

    await query(
      `INSERT INTO sd_store_credit_transactions
         (shop_id, shopify_gid, customer_id, account_gid, amount,
          balance_after, currency_code, event, origin_type, shopify_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       -- Corrective, not insert-only. The export is full every time, and
       -- DO NOTHING meant a row written by an earlier, wronger version stayed
       -- wrong forever: the rows most needing a fix were the ones a re-sync
       -- would skip.
       ON CONFLICT (shopify_gid) DO UPDATE SET
         amount = EXCLUDED.amount,
         balance_after = EXCLUDED.balance_after,
         event = EXCLUDED.event,
         origin_type = EXCLUDED.origin_type`,
      [shop.id, `sct_${syntheticGid}`, customerId, accountGid,
       isDebit ? -raw : raw,
       t.balanceAfterTransaction?.amount ?? null,
       t.amount?.currencyCode ?? shop.currency_code,
       t.event ?? null,
       // The Shopify type, not a two-value flag. An expiry and a spend are both
       // debits and are not the same thing to whoever reads the report.
       typeName.replace(/^StoreCreditAccount|Transaction$/g, '') || (isDebit ? 'Debit' : 'Credit'),
       t.createdAt]);
  }

  /**
   * One customer's store credit, without the bulk export.
   *
   * The nightly export walks every customer because there is no way to ask
   * Shopify for "customers with store credit". When the customer is already
   * known -- after a refund, which is where store credit usually comes from --
   * that is a single cheap query instead, and it means credit issued this
   * morning shows today rather than tomorrow.
   */
  async syncCustomer(customerGid: string): Promise<number> {
    if (this.shopify.source.kind !== 'live') return 0;
    const shop = await this.shops.get();

    const data = await this.shopify.source.graphql<any>(
      `query($id: ID!) {
         customer(id: $id) {
           id
           storeCreditAccounts(first: 5) { nodes {
             id
             balance { amount currencyCode }
             transactions(first: 250) { nodes {
               __typename createdAt event
               amount { amount currencyCode }
               balanceAfterTransaction { amount }
             } }
           } }
         }
       }`, { id: customerGid });

    const accounts = data?.customer?.storeCreditAccounts?.nodes ?? [];
    if (!accounts.length) return 0;

    const customer = await one(
      `SELECT id FROM sd_customers WHERE shopify_gid = $1`, [customerGid]);
    if (!customer) return 0;

    let n = 0;
    let balance = 0;
    for (const acct of accounts) {
      balance += Number(acct.balance?.amount ?? 0);
      for (const t of acct.transactions?.nodes ?? []) {
        await this.writeTransaction(shop, customer.id, acct.id, t);
        n++;
      }
    }
    await query(
      `UPDATE sd_customers SET store_credit_balance = $2 WHERE id = $1`,
      [customer.id, balance]);

    this.log.log(`store credit for ${customerGid}: ${n} transactions, balance ${balance}`);
    return n;
  }

  private async waitFor(opId: string, timeoutMs = 10 * 60_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = await this.shopify.source.graphql<any>(
        `query($id: ID!) { node(id: $id) {
           ... on BulkOperation { status errorCode url objectCount } } }`, { id: opId });
      const op = d?.node;
      if (op?.status === 'COMPLETED') return op.url ?? null;
      if (op?.status && op.status !== 'RUNNING' && op.status !== 'CREATED') {
        throw new Error(`store credit export ended ${op.status}: ${op.errorCode ?? 'no code'}`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error('store credit export did not finish within the timeout');
  }

  /**
   * Stream the JSONL and write the transactions.
   *
   * Three levels deep -- customer, account, transaction -- so `__parentId`
   * chains rather than pointing straight at the customer. Accounts are held in
   * a map on the way past so a transaction can be resolved back to its
   * customer; nothing else about them is kept except the balance.
   */
  private async ingest(shop: Shop, url: string): Promise<number> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`store credit download failed: ${res.status}`);
    if (!res.body) return 0;

    const accountToCustomer = new Map<string, string>();
    const balances = new Map<string, { amount: number; currency: string }>();
    let written = 0;
    let skipped = 0;

    const rl = createInterface({
      input: Readable.fromWeb(res.body as any), crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      // A store credit account: remember which customer it belongs to.
      if (obj.balance !== undefined && obj.__parentId) {
        accountToCustomer.set(obj.id, obj.__parentId);
        /* Added, not assigned. A customer can hold several accounts -- one per
           currency -- and the first version overwrote, so a customer with two
           accounts ended up showing whichever happened to be exported last
           rather than what they actually hold. */
        const seen = balances.get(obj.__parentId);
        balances.set(obj.__parentId, {
          amount: (seen?.amount ?? 0) + Number(obj.balance?.amount ?? 0),
          currency: obj.balance?.currencyCode ?? seen?.currency ?? shop.currency_code,
        });
        continue;
      }

      // A transaction: its parent is the account, whose parent is the customer.
      if (obj.amount !== undefined && obj.__parentId) {
        // Stands in for the id the interface does not expose. Deterministic, so
        // re-exporting the same transaction updates its row rather than
        // duplicating it.
        const customerGid = accountToCustomer.get(obj.__parentId);
        if (!customerGid) continue;
        const customer = await one(
          `SELECT id FROM sd_customers WHERE shopify_gid = $1`, [customerGid]);
        /* Counted, not silently dropped.
        
           A customer Shopify knows about but the mirror does not is not a
           corrupt export -- it is an order backfill that has not run or has not
           finished. Skipping in silence made that look like missing store
           credit instead: the sync reported a number, the dashboard showed
           fewer holders, and nothing said the two were describing different
           populations. */
        if (!customer) { skipped++; continue; }

        await this.writeTransaction(shop, customer.id, obj.__parentId, obj);
        written++;
      }
    }

    // Balances last, so the customer row agrees with Shopify's own figure
    // rather than with our sum of the ledger.
    for (const [customerGid, bal] of balances) {
      await query(
        `UPDATE sd_customers SET store_credit_balance = $2 WHERE shopify_gid = $1`,
        [customerGid, bal.amount]);
    }

    /* The ledger must add up to the balance Shopify reports, and when it does
       not the ledger is missing rows. This is exactly how the interface-vs-
       fragments bug was found: one customer summed to 200 against a balance of
       300, and nothing else would have shown it. Checked on every run, because
       a silent gap here is a report that is quietly wrong rather than empty. */
    const drift = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT c.id
           FROM sd_customers c
           LEFT JOIN sd_store_credit_transactions t ON t.customer_id = c.id
          WHERE c.shop_id = $1 AND c.store_credit_balance <> 0
          GROUP BY c.id, c.store_credit_balance
         HAVING ABS(c.store_credit_balance - COALESCE(SUM(t.amount), 0)) > 0.01
       ) x`, [shop.id]);
    const off = Number(drift[0]?.n ?? 0);
    if (off) {
      this.log.warn(
        `${off} customers whose transactions do not sum to their Shopify balance — ` +
        `the ledger is missing rows, not merely stale`);
    }

    if (skipped) {
      this.log.warn(
        `store credit: skipped ${skipped} transactions for customers not in the ` +
        `mirror — run the order backfill first, then re-run this`);
    }

    this.log.log(`store credit: ${written} transactions, ${balances.size} accounts`);
    return written;
  }

  private async markSync(shop: Shop, n: number) {
    await query(
      `UPDATE sd_sync_state
          SET watermark = now(), last_run_at = now(), last_ok_at = now(),
              status = 'OK', records = $2
        WHERE shop_id = $1 AND resource = 'store_credit'`, [shop.id, n]);
  }

  /* ----------------------------------------------------------------- reads -- */

  /** Issued, spent and outstanding for a range. Credits and debits are summed
   *  separately because the net alone hides both. */
  async totals(shop: Shop, start: Date, end: Date) {
    const [row] = await query<any>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)  AS issued,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0) AS spent,
              COUNT(*) FILTER (WHERE amount > 0)                  AS issue_count,
              COUNT(*) FILTER (WHERE amount < 0)                  AS spend_count
         FROM sd_store_credit_transactions
        WHERE shop_id = $1 AND shopify_created_at >= $2 AND shopify_created_at <= $3`,
      [shop.id, start, end]);

    const [bal] = await query<any>(
      `SELECT COALESCE(SUM(store_credit_balance), 0) AS outstanding,
              COUNT(*) FILTER (WHERE store_credit_balance > 0) AS holders
         FROM sd_customers WHERE shop_id = $1 AND deleted_at IS NULL`, [shop.id]);

    const issued = Number(row?.issued ?? 0);
    const spent = Number(row?.spent ?? 0);
    return {
      issued, spent,
      issueCount: Number(row?.issue_count ?? 0),
      spendCount: Number(row?.spend_count ?? 0),
      /* Of what was issued in this window, how much has been used. Not a
         cohort figure -- credit issued in June and spent in July counts as
         spend in July -- but it is the ratio people mean when they ask whether
         store credit is working. */
      redemptionRate: issued ? spent / issued : 0,
      outstanding: Number(bal?.outstanding ?? 0),
      holders: Number(bal?.holders ?? 0),
    };
  }

  /** Issued against spent per bucket. */
  async series(shop: Shop, start: Date, end: Date, grain: 'hour' | 'day') {
    return query<any>(
      `SELECT date_trunc($4, shopify_created_at AT TIME ZONE $5) AS bucket,
              COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)  AS issued,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0) AS spent
         FROM sd_store_credit_transactions
        WHERE shop_id = $1 AND shopify_created_at >= $2 AND shopify_created_at <= $3
        GROUP BY 1 ORDER BY 1`,
      [shop.id, start, end, grain, shop.iana_timezone]);
  }

  /** Why credit was issued, in Shopify's own vocabulary. */
  async byEvent(shop: Shop, start: Date, end: Date) {
    const rows = await query<{ event: string; n: string; total: string }>(
      `SELECT COALESCE(event, 'unspecified') AS event,
              COUNT(*) AS n, COALESCE(SUM(ABS(amount)), 0) AS total
         FROM sd_store_credit_transactions
        WHERE shop_id = $1 AND shopify_created_at >= $2 AND shopify_created_at <= $3
        GROUP BY 1 ORDER BY 3 DESC`, [shop.id, start, end]);
    return rows.map((r) => ({
      label: String(r.event).toLowerCase().replace(/_/g, ' '),
      value: Number(r.total),
    }));
  }

  /** Who is holding credit. Identities behind sales.customer.view, as
   *  everywhere else. */
  async holders(shop: Shop, showIdentity: boolean, limit = 15) {
    const rows = await query<any>(
      `SELECT display_name, email, store_credit_balance, orders_count, last_order_at
         FROM sd_customers
        WHERE shop_id = $1 AND deleted_at IS NULL AND store_credit_balance > 0
        ORDER BY store_credit_balance DESC LIMIT $2`, [shop.id, limit]);

    return rows.map((r, i) => ({
      rank: i + 1,
      ...(showIdentity ? { customer: r.display_name ?? r.email ?? '—' } : {}),
      balance: Number(r.store_credit_balance ?? 0),
      orders: Number(r.orders_count ?? 0),
      lastOrder: r.last_order_at,
    }));
  }
}