/**
 * Order upserts: ordering, mutable fields, line-item authority, atomicity.
 *
 *   DATABASE_URL=... npx tsx test/orders.test.ts
 *
 * Against a real PostgreSQL and the real schema, because every property here
 * is a property of the SQL. The ordering guard is a condition on a conflicting
 * update, the line-item prune is a DELETE with an array predicate, and
 * atomicity is a transaction: none of them can be shown with a mock, and the
 * first version of each was wrong in a way that typechecked.
 *
 * It writes under its own shop and deletes what it made. It must not be
 * pointed at production.
 */
import { query, one, closeDb, pool } from '../src/common/db';
import { SyncService } from '../src/modules/sales-dashboard/sync/sync.service';
import { WebhookProcessor } from '../src/modules/sales-dashboard/webhooks/webhook-processor';

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`); }
}
const eq = (name: string, a: any, b: any) =>
  check(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (t: string) => console.log(`\n${t}`);

const SHOP_DOMAIN = 'phase2-test.myshopify.com';
let shopId: string;

/** The service with only the collaborators upsertOrders actually uses. */
function service(): SyncService {
  const shops = { get: async () => (await one<any>(`SELECT * FROM sd_shops WHERE id = $1`, [shopId])) };
  return new SyncService(shops as any, {} as any, {} as any, {} as any, {} as any);
}

const money = (amount: string) => ({ shopMoney: { amount } });

/** A Shopify order node, with everything the upsert reads. */
function order(over: Record<string, any> = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#P2-1001',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
    processedAt: null,
    test: false,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    sourceName: 'web',
    tags: ['new'],
    currencyCode: 'EGP',
    totalPriceSet: { shopMoney: { amount: '1000' }, presentmentMoney: { amount: '1000' } },
    currentTotalPriceSet: money('1000'),
    subtotalPriceSet: money('900'),
    currentSubtotalPriceSet: money('900'),
    totalDiscountsSet: money('0'),
    totalTaxSet: money('50'),
    totalShippingPriceSet: money('50'),
    totalRefundedSet: money('0'),
    netPaymentSet: money('1000'),
    totalOutstandingSet: money('0'),
    shippingAddress: { city: 'Cairo', province: 'Cairo', country: 'Egypt', zip: '11835' },
    ...over,
  };
}

const read = () => one<any>(`SELECT * FROM sd_orders WHERE shopify_gid = $1`, ['gid://shopify/Order/1001']);
const lines = () => query<any>(
  `SELECT li.shopify_gid, li.quantity, li.title FROM sd_order_line_items li
     JOIN sd_orders o ON o.id = li.order_id
    WHERE o.shopify_gid = $1 ORDER BY li.shopify_gid`, ['gid://shopify/Order/1001']);
const refunds = () => query<any>(
  `SELECT r.shopify_gid, r.total_refunded FROM sd_refunds r
     JOIN sd_orders o ON o.id = r.order_id
    WHERE o.shopify_gid = $1 ORDER BY r.shopify_gid`, ['gid://shopify/Order/1001']);

async function clean() {
  await query(`DELETE FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_customers WHERE shop_id = $1`, [shopId]);
}

async function main() {
  const existing = await one<any>(
    `SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);
  shopId = existing?.id ?? (await one<any>(
    `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
     VALUES ($1,'Phase 2 fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP_DOMAIN])).id;
  await clean();

  const sync = service();

  /* ------------------------------------------------ repeating a payload -- */
  section('The same update delivered twice');
  {
    await sync.upsertOrders([order({ lineItems: { nodes: [
      { id: 'gid://shopify/LineItem/1', title: 'Roses', quantity: 2,
        originalTotalSet: money('500'), discountedTotalSet: money('500') },
    ] } })]);
    const first = await read();

    const n = await sync.upsertOrders([order({ lineItems: { nodes: [
      { id: 'gid://shopify/LineItem/1', title: 'Roses', quantity: 2,
        originalTotalSet: money('500'), discountedTotalSet: money('500') },
    ] } })]);
    const second = await read();

    eq('the repeat is applied rather than refused', n, 1);
    eq('the row is unchanged', Number(second.total_price), Number(first.total_price));
    eq('and the line is not duplicated', (await lines()).length, 1);
    eq('one order row exists', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id = $1`, [shopId])).n), 1);
  }

  /* --------------------------------------------- an older payload, late -- */
  section('An older version arriving after a newer one');
  {
    await clean();
    await sync.upsertOrders([order({
      updatedAt: '2026-05-01T12:00:00Z',
      displayFinancialStatus: 'PAID', totalPriceSet: { shopMoney: { amount: '2000' } },
      tags: ['paid'],
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1', title: 'Roses', quantity: 2,
        originalTotalSet: money('500'), discountedTotalSet: money('500') }] },
    })]);

    // The pre-refund figures a reconciliation page fetched before the webhook.
    const n = await sync.upsertOrders([order({
      updatedAt: '2026-05-01T11:00:00Z',
      displayFinancialStatus: 'PENDING', totalPriceSet: { shopMoney: { amount: '1000' } },
      tags: ['stale'],
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/STALE', title: 'Stale line', quantity: 9,
        originalTotalSet: money('1'), discountedTotalSet: money('1') }] },
    })]);
    const row = await read();

    eq('the stale payload is not counted as written', n, 0);
    eq('the newer financial status stands', row.financial_status, 'PAID');
    eq('the newer total stands', Number(row.total_price), 2000);
    eq('the newer tags stand', row.tags, ['paid']);
    check('the stored timestamp is still the newer one',
      new Date(row.shopify_updated_at).toISOString() === '2026-05-01T12:00:00.000Z',
      new Date(row.shopify_updated_at).toISOString());

    /* The part that used to leak. The guard only covered the order row, so a
       refused payload still rewrote line items and refunds underneath it. */
    const l = await lines();
    eq('and its line items are refused with it', l.length, 1);
    eq('the stored line is the newer one', l[0].shopify_gid, 'gid://shopify/LineItem/1');
  }

  /* ------------------------------------------------ concurrent arrivals -- */
  section('Two writers racing on one order');
  {
    await clean();
    await sync.upsertOrders([order({ updatedAt: '2026-05-01T10:00:00Z' })]);

    /* Both read the same row, both believe they are newer, and they write in
       whichever order the scheduler allows. The guard is a condition on the
       conflicting update, evaluated under the row lock, so the result does not
       depend on who wins the race. */
    const newer = order({ updatedAt: '2026-05-01T13:00:00Z',
      displayFinancialStatus: 'PAID', totalPriceSet: { shopMoney: { amount: '3000' } } });
    const older = order({ updatedAt: '2026-05-01T11:00:00Z',
      displayFinancialStatus: 'PENDING', totalPriceSet: { shopMoney: { amount: '1500' } } });

    await Promise.all([
      sync.upsertOrders([newer]),
      sync.upsertOrders([older]),
    ]);
    const a = await read();
    eq('the newer value survives regardless of arrival order', Number(a.total_price), 3000);
    eq('and so does its status', a.financial_status, 'PAID');

    // And the reverse dispatch order, which is the one that used to lose.
    await clean();
    await sync.upsertOrders([order({ updatedAt: '2026-05-01T10:00:00Z' })]);
    await Promise.all([
      sync.upsertOrders([older]),
      sync.upsertOrders([newer]),
    ]);
    const b = await read();
    eq('the same holds when the older one is dispatched first', Number(b.total_price), 3000);
  }

  /* ------------------------------------- the race, forced rather than hoped -- */
  section('Two transactions overlapping on the same row');
  {
    /* The previous section depends on the scheduler to interleave. This one
       does not: it stages the exact sequence the old read-then-write guard
       could not survive -- the losing writer takes its decision first, and
       commits last.
    
         A: BEGIN, reads the row, sees 10:00, decides 11:00 is newer
         B: writes 13:00 and commits
         A: writes 11:00 and commits
    
       With the guard in application code A's write lands, because A's read
       happened before B existed. As a condition on the conflicting update it
       is evaluated while A holds the row lock, against what B actually left
       there, so A's write is refused instead. */
    await clean();
    await sync.upsertOrders([order({ updatedAt: '2026-05-01T10:00:00Z',
      totalPriceSet: { shopMoney: { amount: '1000' } } })]);

    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      const seen = (await a.query(
        `SELECT shopify_updated_at FROM sd_orders WHERE shopify_gid = $1`,
        ['gid://shopify/Order/1001'])).rows[0];
      check('A reads the row before B touches it',
        new Date(seen.shopify_updated_at).toISOString() === '2026-05-01T10:00:00.000Z');

      // B, on its own connection, commits a newer version.
      await sync.upsertOrders([order({ updatedAt: '2026-05-01T13:00:00Z',
        displayFinancialStatus: 'PAID', totalPriceSet: { shopMoney: { amount: '3000' } } })]);

      // A now writes what it decided was newer than the 10:00 it read.
      const applied = await a.query(
        `INSERT INTO sd_orders (shop_id, shopify_gid, name, order_number,
            shopify_created_at, shopify_updated_at, total_price, currency_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'EGP')
         ON CONFLICT (shopify_gid) DO UPDATE SET
           shopify_updated_at = EXCLUDED.shopify_updated_at,
           total_price = EXCLUDED.total_price
         WHERE EXCLUDED.shopify_updated_at >= sd_orders.shopify_updated_at
         RETURNING id`,
        [shopId, 'gid://shopify/Order/1001', '#P2-1001', 1001,
         new Date('2026-05-01T10:00:00Z'), new Date('2026-05-01T11:00:00Z'), 1500]);
      await a.query('COMMIT');

      eq('A\'s older write is refused by the database', applied.rowCount, 0);
    } finally { a.release(); }

    const row = await read();
    eq('the newer total stands after both commit', Number(row.total_price), 3000);
    eq('and the newer status', row.financial_status, 'PAID');
    check('and the timestamp was never walked backwards',
      new Date(row.shopify_updated_at).toISOString() === '2026-05-01T13:00:00.000Z',
      new Date(row.shopify_updated_at).toISOString());
  }

  /* ------------------------------- the webhook path's own order write -- */
  section('The webhook write obeys the same ordering guard');
  {
    /* A second write path exists. `applyOrder` reads the stored timestamp,
       compares in JavaScript and then wrote unconditionally -- the same
       read-then-write the order upsert used to have, and reconciliation can
       commit between the two. The real method is called here, through the real
       SQL, rather than a copy of the statement. */
    await clean();
    const proc: any = new WebhookProcessor(
      { get: async () => ({ id: shopId }) } as any,
      {} as any, {} as any, sync, {} as any);
    const money = (v: any) => (v == null ? 0 : parseFloat(String(v)));

    // The REST-shaped payload the webhook path receives.
    const payload = (updatedAt: string, total: string, status: string) => ({
      id: 1001, admin_graphql_api_id: 'gid://shopify/Order/1001',
      name: '#P2-1001', order_number: 1001,
      created_at: '2026-05-01T10:00:00Z', updated_at: updatedAt,
      currency: 'EGP', total_price: total, financial_status: status,
    });

    const first = await proc.writeOrder(shopId, payload('2026-06-01T12:00:00Z', '2000', 'paid'),
      'gid://shopify/Order/1001', new Date('2026-06-01T12:00:00Z'), money);
    check('the first write applies', first === true);
    eq('and is stored', Number((await read()).total_price), 2000);

    // An older delivery, arriving after reconciliation wrote something newer.
    const stale = await proc.writeOrder(shopId, payload('2026-06-01T11:00:00Z', '1000', 'pending'),
      'gid://shopify/Order/1001', new Date('2026-06-01T11:00:00Z'), money);
    check('an older webhook delivery is refused by the database', stale === false);

    const row = await read();
    eq('the newer total survives', Number(row.total_price), 2000);
    eq('and the newer status', row.financial_status, 'PAID');
    check('the timestamp was not walked backwards',
      new Date(row.shopify_updated_at).toISOString() === '2026-06-01T12:00:00.000Z',
      new Date(row.shopify_updated_at).toISOString());

    /* The returned boolean is what decides PROCESSED versus STALE on the
       event, so reporting true for a refused write recorded a delivery as
       applied when it had not been. */
    check('so the event can be recorded STALE rather than PROCESSED', stale === false);

    // Replaying the identical delivery must still apply.
    const replay = await proc.writeOrder(shopId, payload('2026-06-01T12:00:00Z', '2000', 'paid'),
      'gid://shopify/Order/1001', new Date('2026-06-01T12:00:00Z'), money);
    check('an equal timestamp still applies, so replay stays possible', replay === true);
  }

  /* ------------------------ the event is recorded STALE, and stays STALE -- */
  section('A refused webhook write is recorded STALE and never becomes PROCESSED');
  {
    /* The order guard being right is not enough. Whether a delivery the
       database refused is *recorded* as stale depends on a boolean surviving
       four layers -- writeOrder -> applyOrder -> apply -> processOne -- and on
       nothing after the status write moving it again. This drives the real
       entry point, enqueue(), against a real database and a real Redis, and
       reads the status back from the table rather than from a return value.

       The race is staged rather than hoped for: applyOrder's JavaScript
       pre-read must PASS (the stored row looks older than the payload), and
       only then does a newer version commit, exactly as reconciliation can
       between that read and the write. The database guard is then the only
       thing standing between the stale payload and the row. */
    await clean();

    const proc: any = new WebhookProcessor(
      { get: async () => ({ id: shopId }) } as any,
      { scheduleRefresh: () => { calls.refresh++; } } as any,
      {} as any, sync, {} as any);

    /* Everything that only a PROCESSED event should trigger, counted. The
       positive control below proves these counters actually move, so a zero in
       the stale case means something. */
    const calls = { publish: 0, hydrate: 0, refresh: 0 };
    proc.publish = async () => { calls.publish++; };
    proc.hydrateWithRetry = async () => { calls.hydrate++; };
    const reset = () => { calls.publish = 0; calls.hydrate = 0; calls.refresh = 0; };

    let seq = 0;
    const insertEvent = async (updatedAt: string, total: string) => {
      const payload = {
        id: 1001, admin_graphql_api_id: 'gid://shopify/Order/1001',
        name: '#P2-1001', order_number: 1001,
        created_at: '2026-05-01T10:00:00Z', updated_at: updatedAt,
        currency: 'EGP', total_price: total, financial_status: 'pending',
      };
      return (await one<any>(
        `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, triggered_at, payload)
         VALUES ($1,$2,'orders/updated',$3,$4::jsonb) RETURNING id`,
        [shopId, `wh-stale-${Date.now()}-${++seq}`, updatedAt, JSON.stringify(payload)])).id as string;
    };
    const status = async (id: string) => one<any>(
      `SELECT status, attempts, processed_at, error FROM sd_webhook_events WHERE id = $1`, [id]);

    /* Drive enqueue(), then wait for the setImmediate it schedules. Polled
       rather than slept for a fixed time, so the test neither races it nor
       passes by finishing before it has run. */
    const run = async (id: string) => {
      await proc.enqueue(id);
      for (let i = 0; i < 100; i++) {
        if ((await status(id)).status !== 'PENDING') return;
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    // ---- positive control: a genuinely newer delivery is PROCESSED ----------
    await sync.upsertOrders([order({ updatedAt: '2026-06-01T10:00:00Z',
      totalPriceSet: { shopMoney: { amount: '1000' } } })]);
    reset();
    const fresh = await insertEvent('2026-06-01T11:00:00Z', '1100');
    await run(fresh);
    eq('control: a newer delivery is recorded PROCESSED', (await status(fresh)).status, 'PROCESSED');
    eq('control: and its total was applied', Number((await read()).total_price), 1100);
    check('control: publish, snapshot refresh and hydration all ran',
      calls.publish === 1 && calls.refresh === 1 && calls.hydrate === 1,
      JSON.stringify(calls));

    // ---- the race: pre-read passes, a newer version commits, guard refuses ----
    await clean();
    await sync.upsertOrders([order({ updatedAt: '2026-06-01T10:00:00Z',
      totalPriceSet: { shopMoney: { amount: '1000' } } })]);

    const realWrite = proc.writeOrder.bind(proc);
    let interleaved = false;
    proc.writeOrder = async (...args: any[]) => {
      // applyOrder's pre-read has already run and let this payload through.
      // Reconciliation commits a later version of the same order right now.
      await sync.upsertOrders([order({ updatedAt: '2026-06-01T13:00:00Z',
        displayFinancialStatus: 'PAID', totalPriceSet: { shopMoney: { amount: '3000' } } })]);
      interleaved = true;
      return realWrite(...args);
    };

    reset();
    const racing = await insertEvent('2026-06-01T11:00:00Z', '1100');
    await run(racing);
    proc.writeOrder = realWrite;

    check('the newer version committed between the pre-read and the write', interleaved);
    const rec = await status(racing);
    eq('the refused delivery is recorded STALE', rec.status, 'STALE');
    check('with a processed_at, so it is visibly finished rather than pending', !!rec.processed_at);
    eq('after exactly one attempt', rec.attempts, 1);
    check('and no error recorded, since nothing failed', rec.error === null, String(rec.error));
    eq('the newer total survived', Number((await read()).total_price), 3000);

    check('no PROCESSED-only work ran: no publish', calls.publish === 0, JSON.stringify(calls));
    check('no snapshot refresh', calls.refresh === 0, JSON.stringify(calls));
    check('and no hydration, which would re-fetch and re-apply on top',
      calls.hydrate === 0, JSON.stringify(calls));

    // ---- nothing later moves it -------------------------------------------
    await new Promise((r) => setTimeout(r, 300));
    eq('still STALE after the event loop has drained', (await status(racing)).status, 'STALE');

    /* Delivering the same webhook again must not reopen it. Ingest absorbs a
       duplicate with ON CONFLICT (webhook_id) DO NOTHING and enqueues only when
       a row was inserted, so the STALE row is never touched. Asserted at the
       table, where it matters. */
    const dup = await query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload)
       SELECT shop_id, webhook_id, topic, payload FROM sd_webhook_events WHERE id = $1
       ON CONFLICT (webhook_id) DO NOTHING RETURNING id`, [racing]);
    eq('a duplicate delivery inserts nothing', dup.length, 0);
    eq('so the STALE row is untouched', (await status(racing)).status, 'STALE');

    /* enqueue() also leaves the id on the Redis list for the worker, so the
       same event can be processed a second time. It must reach the same
       verdict: STALE is not a state that a retry can talk its way out of,
       because the stored timestamp only ever moves forward. */
    reset();
    await proc.processOne(racing);
    const again = await status(racing);
    eq('processing the same event a second time is still STALE', again.status, 'STALE');
    eq('the retry is counted', again.attempts, 2);
    check('and still triggers no PROCESSED-only work',
      calls.publish === 0 && calls.refresh === 0 && calls.hydrate === 0, JSON.stringify(calls));

    // ---- the earlier, JavaScript-level refusal records the same way ----------
    reset();
    const early = await insertEvent('2026-06-01T09:00:00Z', '900');   // older than 13:00
    await run(early);
    eq('a delivery the pre-read refuses is STALE too', (await status(early)).status, 'STALE');
    check('and triggers no PROCESSED-only work',
      calls.publish === 0 && calls.refresh === 0 && calls.hydrate === 0, JSON.stringify(calls));
  }

  /* ----------------------------------------- mutable fields on conflict -- */
  section('Fields that change in Shopify after the first write');
  {
    await clean();
    await sync.upsertOrders([order()]);

    await sync.upsertOrders([order({
      updatedAt: '2026-05-02T10:00:00Z',
      processedAt: '2026-05-02T09:00:00Z',
      tags: ['fincart', 'shipped'],
      displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: { shopMoney: { amount: '800' }, presentmentMoney: { amount: '800' } },
      currentTotalPriceSet: money('800'),
      subtotalPriceSet: money('700'),
      currentSubtotalPriceSet: money('700'),
      totalDiscountsSet: money('100'),
      totalTaxSet: money('40'),
      totalShippingPriceSet: money('60'),
    })]);
    const row = await read();

    /* These five were frozen at their first value while total_price moved, so
       the row stated a total its own components contradicted. */
    eq('subtotal follows the edit', Number(row.subtotal_price), 700);
    eq('current subtotal follows', Number(row.current_subtotal_price), 700);
    eq('discounts follow', Number(row.total_discounts), 100);
    eq('tax follows', Number(row.total_tax), 40);
    eq('shipping follows', Number(row.total_shipping), 60);
    eq('presentment total follows', Number(row.presentment_total_price), 800);
    /* No arithmetic identity is asserted between these columns. Shopify's
       subtotal already nets line-level discounts while total_discounts also
       counts order-level ones, so any sum written here would be a rule this
       codebase invented rather than one Shopify keeps. What matters is that
       the components move with the total instead of being frozen. */
    check('every component moved away from its first value',
      Number(row.subtotal_price) !== 900 && Number(row.total_discounts) !== 0
        && Number(row.total_tax) !== 50 && Number(row.total_shipping) !== 50);

    eq('tags follow, which the fulfilment screen reads', row.tags, ['fincart', 'shipped']);
    check('processed_at follows', !!row.processed_at);
    eq('fulfillment status follows', row.fulfillment_status, 'FULFILLED');
  }

  /* ------------------------------------- a payload that omits the address -- */
  section('A payload that omits fields the webhook had supplied');
  {
    await clean();
    await sync.upsertOrders([order()]);                       // webhook: has address
    const before = await read();
    eq('the address is stored', before.ship_city, 'Cairo');

    // Hydration reads the order without shippingAddress or customer.
    const hydrated: any = order({ updatedAt: '2026-05-02T10:00:00Z' });
    delete hydrated.shippingAddress;
    await sync.upsertOrders([hydrated]);
    const after = await read();

    eq('an omitted address does not blank the stored one', after.ship_city, 'Cairo');
    eq('nor the province', after.ship_province, 'Cairo');
    eq('nor the country', after.ship_country, 'Egypt');
  }

  /* ------------------------------------------- empty versus omitted lines -- */
  section('Line items: omitted, present, explicitly empty');
  {
    await clean();
    await sync.upsertOrders([order({ lineItems: { nodes: [
      { id: 'gid://shopify/LineItem/1', title: 'Roses', quantity: 2,
        originalTotalSet: money('500'), discountedTotalSet: money('500') },
      { id: 'gid://shopify/LineItem/2', title: 'Vase', quantity: 1,
        originalTotalSet: money('400'), discountedTotalSet: money('400') },
    ] } })]);
    eq('both lines are stored', (await lines()).length, 2);

    // Omitted: no opinion, leave them alone.
    const silent: any = order({ updatedAt: '2026-05-02T10:00:00Z' });
    await sync.upsertOrders([silent]);
    eq('a payload with no lineItems field leaves them untouched', (await lines()).length, 2);

    // An edit: one line changed, one removed.
    await sync.upsertOrders([order({ updatedAt: '2026-05-03T10:00:00Z', lineItems: { nodes: [
      { id: 'gid://shopify/LineItem/1', title: 'Roses, larger', quantity: 5,
        originalTotalSet: money('900'), discountedTotalSet: money('900') },
    ] } })]);
    const edited = await lines();
    eq('the removed line is pruned', edited.length, 1);
    eq('the edited quantity is corrected', edited[0]?.quantity, 5);
    eq('and so is the title', edited[0]?.title, 'Roses, larger');

    /* An empty list is NOT taken as authoritative.
    
       It was briefly, and that was wrong in a way that destroys data. The bulk
       reassembly gives every order `nodes: []` by default and fills it as
       children are read, so an export whose tail was lost presents real orders
       as having none -- and a Shopify order always carries at least one line,
       so a genuine empty list is close to unobservable. The safe reading of no
       evidence is to change nothing. */
    await sync.upsertOrders([order({ updatedAt: '2026-05-04T10:00:00Z',
      lineItems: { nodes: [] } })]);
    eq('an empty list does not delete the stored lines', (await lines()).length, 1);
    eq('and the stored line is untouched', (await lines())[0]?.shopify_gid,
      'gid://shopify/LineItem/1');
  }

  /* ------------------------------------------------ a truncated list -- */
  section('A line-item list cut off at the page limit');
  {
    /* The read asks for a hundred line items. An order with more returns the
       first hundred and, without pageInfo, looks identical to a complete list
       -- so the prune deleted everything past the hundredth on every pass,
       while the bulk import (which has no limit) kept writing them back. */
    await clean();

    const many = Array.from({ length: 4 }, (_, i) => ({
      id: `gid://shopify/LineItem/${100 + i}`, title: `Item ${i}`, quantity: 1,
      originalTotalSet: money('10'), discountedTotalSet: money('10'),
    }));
    await sync.upsertOrders([order({
      lineItems: { nodes: many },        // bulk import: no limit, no pageInfo
    })]);
    eq('the import writes every line', (await lines()).length, 4);

    // Reconciliation now sees only the first two, and says so.
    await sync.upsertOrders([order({
      updatedAt: '2026-05-10T10:00:00Z',
      lineItems: { pageInfo: { hasNextPage: true }, nodes: many.slice(0, 2) },
    })]);
    const kept = await lines();
    eq('a truncated list does not delete the lines it could not see', kept.length, 4);

    // The same shape without the truncation flag is complete, and does prune.
    await sync.upsertOrders([order({
      updatedAt: '2026-05-11T10:00:00Z',
      lineItems: { pageInfo: { hasNextPage: false }, nodes: many.slice(0, 2) },
    })]);
    eq('a complete list still prunes what Shopify no longer lists',
      (await lines()).length, 2);
  }

  /* --------------------------------------------------- refunds, repeated -- */
  section('Refunds');
  {
    await clean();
    const withRefund = (amount: string, updatedAt: string) => order({
      updatedAt,
      totalRefundedSet: money(amount),
      refunds: [{ id: 'gid://shopify/Refund/77', createdAt: '2026-05-02T08:00:00Z',
                  totalRefundedSet: money(amount) }],
    });

    await sync.upsertOrders([withRefund('250', '2026-05-02T09:00:00Z')]);
    await sync.upsertOrders([withRefund('250', '2026-05-02T09:00:00Z')]);
    const twice = await refunds();
    eq('the same refund delivered twice is one row', twice.length, 1);
    eq('at the delivered amount, not twice it', Number(twice[0].total_refunded), 250);

    // Adjusted after the fact.
    await sync.upsertOrders([withRefund('400', '2026-05-02T11:00:00Z')]);
    const adjusted = await refunds();
    eq('an adjusted refund updates in place', Number(adjusted[0].total_refunded), 400);
    eq('still one row', adjusted.length, 1);

    // A later payload that does not mention it must not un-issue it.
    await sync.upsertOrders([order({ updatedAt: '2026-05-03T10:00:00Z' })]);
    eq('a payload without refunds does not delete them', (await refunds()).length, 1);
  }

  /* ------------------------------------------------ partial write safety -- */
  section('An interrupted write leaves nothing behind');
  {
    await clean();
    await sync.upsertOrders([order({ lineItems: { nodes: [
      { id: 'gid://shopify/LineItem/1', title: 'Roses', quantity: 2,
        originalTotalSet: money('500'), discountedTotalSet: money('500') },
    ] } })]);
    const before = await read();

    /* A line item that violates NOT NULL on title fails mid-order, after the
       order row and the first line have been written. Before the transaction
       those two stayed: an order updated to a new total with half its lines
       replaced. */
    let threw = false;
    try {
      await sync.upsertOrders([order({
        updatedAt: '2026-05-05T10:00:00Z',
        totalPriceSet: { shopMoney: { amount: '9999' } },
        lineItems: { nodes: [
          { id: 'gid://shopify/LineItem/9', title: 'Good line', quantity: 1,
            originalTotalSet: money('10'), discountedTotalSet: money('10') },
          { id: 'gid://shopify/LineItem/10', title: null, quantity: 1,
            originalTotalSet: money('10'), discountedTotalSet: money('10') },
        ],
      } })]);
    } catch { threw = true; }

    check('the failure surfaces', threw);
    const after = await read();
    eq('the order row is rolled back to its previous total',
      Number(after.total_price), Number(before.total_price));
    check('the timestamp did not move either',
      new Date(after.shopify_updated_at).toISOString()
        === new Date(before.shopify_updated_at).toISOString());
    const l = await lines();
    eq('no half-written line survives', l.length, 1);
    eq('and it is the original one', l[0].shopify_gid, 'gid://shopify/LineItem/1');
  }

  /* -------------------------------------------- customer spend recompute -- */
  section('Customer spend, recomputed rather than accumulated');
  {
    await clean();
    const customer = { id: 'gid://shopify/Customer/55', displayName: 'Mona Adel',
                       email: 'mona@example.com', numberOfOrders: 2,
                       createdAt: '2026-01-01T00:00:00Z' };

    const mk = (gid: string, name: string, net: string, over: any = {}) => ({
      ...order({ ...over }), id: gid, name,
      customer, netPaymentSet: money(net),
    });

    await sync.upsertOrders([
      mk('gid://shopify/Order/2001', '#P2-2001', '1000'),
      mk('gid://shopify/Order/2002', '#P2-2002', '500'),
    ]);
    const c1 = await one<any>(
      `SELECT * FROM sd_customers WHERE shopify_gid = $1`, ['gid://shopify/Customer/55']);
    eq('spend is the sum of the orders', Number(c1.total_spent), 1500);
    eq('and the count is ours, not Shopify\'s', Number(c1.orders_count), 2);

    // Running the same batch again must not double anything.
    await sync.upsertOrders([
      mk('gid://shopify/Order/2001', '#P2-2001', '1000'),
      mk('gid://shopify/Order/2002', '#P2-2002', '500'),
    ]);
    const c2 = await one<any>(
      `SELECT * FROM sd_customers WHERE shopify_gid = $1`, ['gid://shopify/Customer/55']);
    eq('repeating the batch leaves spend unchanged', Number(c2.total_spent), 1500);
    eq('and the count unchanged', Number(c2.orders_count), 2);

    // A cancellation must bring both down, which an accumulator could not do.
    await sync.upsertOrders([
      mk('gid://shopify/Order/2002', '#P2-2002', '500',
        { updatedAt: '2026-05-06T10:00:00Z', cancelledAt: '2026-05-06T10:00:00Z' }),
    ]);
    const c3 = await one<any>(
      `SELECT * FROM sd_customers WHERE shopify_gid = $1`, ['gid://shopify/Customer/55']);
    eq('a cancelled order leaves the spend', Number(c3.total_spent), 1000);
    eq('and the count', Number(c3.orders_count), 1);
  }

  await clean();
  /* upsertOrders stamps the customers resource, so the fixture shop now owns a
     sync-state row and cannot be removed until it goes. */
  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });