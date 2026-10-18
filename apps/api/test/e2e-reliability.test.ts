/**
 * The whole chain, under the conditions that actually happen.
 *
 *   DATABASE_URL=... npx tsx test/e2e-reliability.test.ts
 *
 * Each earlier phase proved its own piece in isolation. This asks whether the
 * pieces hold together when several things go wrong at once -- a webhook
 * redelivered while a worker is crashing, a reconciliation interleaving with a
 * webhook on the same order, a backfill interrupted midway.
 *
 * It uses the real services with only the outward edges stubbed: the real
 * worker, the real upsert path, the real claim and lease. Nothing reaches
 * Shopify and nothing is started on a schedule.
 */
import { query, one, closeDb } from '../src/common/db';
import { SyncService } from '../src/modules/sales-dashboard/sync/sync.service';
import { WebhookProcessor } from '../src/modules/sales-dashboard/webhooks/webhook-processor';
import { WebhookWorker } from '../src/modules/sales-dashboard/webhooks/webhook-worker';
import { MAX_ATTEMPTS } from '../src/modules/sales-dashboard/webhooks/webhook-lifecycle';
import { streamBulkJsonl } from '../src/modules/sales-dashboard/sync/bulk-stream';
import { paginateOrders, resumePlan, nextResume, nextWatermark } from '../src/modules/sales-dashboard/sync/reconcile-pages';
import { acquire, withJobLock } from '../src/common/job-lock';

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

const SHOP = 'e2e-test.myshopify.com';
const GID = 'gid://shopify/Order/9001';
let shopId: string;
let seq = 0;

const shops = () => ({ get: async () => one<any>(`SELECT * FROM sd_shops WHERE id = $1`, [shopId]) });
const sync = () => new SyncService(shops() as any, { source: { kind: 'live' } } as any,
  {} as any, {} as any, {} as any);

function processor(fx: any) {
  const p = new WebhookProcessor(
    shops() as any,
    { scheduleRefresh: () => { fx.refresh++; } } as any,
    { source: { kind: 'live' } } as any,
    sync() as any,
    { syncCustomer: async () => 0 } as any);
  (p as any).publish = async () => {
    fx.publish++;
    if (fx.publishFails) throw new Error('redis unreachable');
  };
  (p as any).hydrateWithRetry = async () => { fx.hydrate++; };
  return p;
}

const worker = (p: any, id: string) => {
  const w = new WebhookWorker(p);
  (w as any).me = id;
  return w;
};

const payload = (over: Record<string, any> = {}) => ({
  id: 9001, admin_graphql_api_id: GID, name: '#E2E-9001', order_number: 9001,
  created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z',
  currency: 'EGP', total_price: '1000', financial_status: 'pending', ...over,
});

const addEvent = async (p: any, webhookId?: string) => {
  const rows = await query<{ id: string }>(
    `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, triggered_at, payload, next_attempt_at)
     VALUES ($1,$2,'orders/updated',$3,$4::jsonb, now())
     ON CONFLICT (webhook_id) DO NOTHING RETURNING id`,
    [shopId, webhookId ?? `e2e-${Date.now()}-${++seq}`, p.updated_at, JSON.stringify(p)]);
  return rows[0]?.id ?? null;
};

const order = () => one<any>(`SELECT * FROM sd_orders WHERE shopify_gid = $1`, [GID]);
const ev = (id: string) => one<any>(
  `SELECT status, attempts, error FROM sd_webhook_events WHERE id = $1`, [id]);

async function clean() {
  await query(`DELETE FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_customers WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM core_job_locks WHERE name LIKE 'e2e:%'`);
}

async function main() {
  shopId = (await one<any>(`SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP]))?.id
    ?? (await one<any>(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ($1,'E2E fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP])).id;
  await clean();

  /* ------------------------------------------------- duplicate delivery -- */
  section('Shopify delivers the same webhook three times');
  {
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const p = processor(fx);
    const w = worker(p, 'w1');

    const id = await addEvent(payload(), 'e2e-dup');
    const second = await addEvent(payload(), 'e2e-dup');
    const third = await addEvent(payload(), 'e2e-dup');

    check('only the first delivery becomes an event', !!id && !second && !third);
    while (await w.runOnce()) { /* drain */ }

    eq('the order is written once', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n), 1);
    eq('the event is processed', (await ev(id!)).status, 'PROCESSED');
    eq('and applied once', fx.hydrate, 1);
  }

  /* -------------------------------------- webhook racing reconciliation -- */
  section('A webhook and a reconciliation touching one order');
  {
    await clean();
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const p = processor(fx);
    const w = worker(p, 'w1');
    const s = sync();

    // The webhook carries the newer state.
    const id = await addEvent(payload({ updated_at: '2026-06-01T12:00:00Z',
      total_price: '2000', financial_status: 'paid' }));
    await w.runOnce();
    eq('the webhook state is stored', Number((await order()).total_price), 2000);

    /* Reconciliation arrives holding a page fetched before the refund -- the
       exact shape that used to overwrite newer data. */
    await s.upsertOrders([{
      id: GID, name: '#E2E-9001', createdAt: '2026-06-01T10:00:00Z',
      updatedAt: '2026-06-01T11:00:00Z', currencyCode: 'EGP',
      displayFinancialStatus: 'PENDING',
      totalPriceSet: { shopMoney: { amount: '1000' } },
    }]);

    const after = await order();
    eq('the older reconciliation page does not win', Number(after.total_price), 2000);
    eq('nor its status', after.financial_status, 'PAID');
    check('and the timestamp never goes backwards',
      new Date(after.shopify_updated_at).toISOString() === '2026-06-01T12:00:00.000Z');
  }

  /* -------------------------------------------- throttling, then success -- */
  section('Shopify throttles, the event retries, then succeeds');
  {
    await clean();
    let attempts = 0;
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const p = processor(fx);
    (p as any).apply = async () => {
      attempts++;
      if (attempts <= 2) throw new Error('THROTTLED');
      return true;
    };
    const w = worker(p, 'w1');
    const id = await addEvent(payload());

    await w.runOnce();
    eq('the first attempt backs off', (await ev(id!)).status, 'FAILED');
    await query(`UPDATE sd_webhook_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await w.runOnce();
    eq('so does the second', (await ev(id!)).status, 'FAILED');
    await query(`UPDATE sd_webhook_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await w.runOnce();

    const final = await ev(id!);
    eq('the third succeeds', final.status, 'PROCESSED');
    eq('with every attempt counted', final.attempts, 3);
    check('and well short of the ceiling', final.attempts < MAX_ATTEMPTS);
  }

  /* --------------------------------- crash between the write and the status -- */
  section('A worker dies after writing but before recording');
  {
    await clean();
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const p = processor(fx);
    const dying = worker(p, 'w-dies');

    const id = await addEvent(payload({ total_price: '1500' }));
    const claimed = await (dying as any).claim();
    // The business write lands.
    await (p as any).applyEvent('orders/updated', payload({ total_price: '1500' }), null);
    // ...and the process disappears before completing.
    check('the order is in the mirror', Number((await order()).total_price) === 1500);
    eq('while the event still says in-flight', (await ev(id!)).status, 'PROCESSING');

    // Another worker takes over once the lease lapses.
    await query(`UPDATE sd_webhook_events SET lease_expires_at = now() - interval '1 second'
                  WHERE id = $1`, [id]);
    const survivor = worker(p, 'w-survives');
    eq('the sweep reclaims it', await survivor.sweepExpiredLeases(), 1);
    eq('and it is processed', await survivor.runOnce(), true);

    const final = await ev(id!);
    eq('reaching a terminal state', final.status, 'PROCESSED');
    eq('the order is still right after the repeat',
      Number((await order()).total_price), 1500);
    eq('and there is still one order row', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n), 1);
  }

  /* --------------------------------------------- publishing fails outright -- */
  section('The dashboard notification fails while everything else works');
  {
    await clean();
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: true };
    const p = processor(fx);
    const w = worker(p, 'w1');
    const id = await addEvent(payload());

    await w.runOnce();
    const e = await ev(id!);
    eq('the event is processed regardless', e.status, 'PROCESSED');
    check('with no error recorded against it', e.error === null, String(e.error));
    check('the order landed', !!(await order()));
    eq('and it is not left claimable', await w.runOnce(), false);
  }

  /* ------------------------------------------- the database goes away -- */
  section('A database interruption during processing');
  {
    await clean();
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const p = processor(fx);
    (p as any).apply = async () => { throw new Error('connection terminated unexpectedly'); };
    const w = worker(p, 'w1');
    const id = await addEvent(payload());

    await w.runOnce();
    const e = await ev(id!);
    eq('the event is kept for retry rather than lost', e.status, 'FAILED');
    check('with the reason recorded', /connection terminated/.test(e.error ?? ''));
    check('and a retry scheduled', !!(await one<any>(
      `SELECT next_attempt_at FROM sd_webhook_events WHERE id=$1`, [id])).next_attempt_at);
  }

  /* ------------------------------------------------ incomplete pagination -- */
  section('Reconciliation stopped by the page ceiling, resumed next run');
  {
    const PAGE = 50, T0 = Date.UTC(2026, 6, 1, 9, 0, 0);
    const all = Array.from({ length: 2500 }, (_, i) => ({
      id: `gid://shopify/Order/${20000 + i}`,
      updatedAt: new Date(T0).toISOString(),      // one bulk edit: all identical
    }));
    const key = (o: any) => `${o.updatedAt}|${o.id}`;
    const enc = (o: any) => Buffer.from(JSON.stringify(
      { last_value: o.updatedAt, last_id: o.id })).toString('base64');
    const fetchPage = (since: string, cursor: string | null) => {
      let m = all.filter((o) => o.updatedAt >= since).sort((a, b) => (key(a) < key(b) ? -1 : 1));
      if (cursor) {
        const c = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        m = m.filter((o) => key(o) > `${c.last_value}|${c.last_id}`);
      }
      const slice = m.slice(0, PAGE);
      return { nodes: slice, hasNextPage: m.length > PAGE,
               endCursor: slice.length ? enc(slice[slice.length - 1]) : null };
    };

    const seen = new Set<string>();
    let state: any = { watermark: new Date(T0 - 60_000), resume_cursor: null, resume_since: null };
    let runs = 0;
    for (let i = 0; i < 6; i++) {
      runs++;
      const plan = resumePlan(state, new Date(T0 + i * 900_000));
      const r = await paginateOrders({
        startCursor: plan.startCursor,
        fetchPage: async (c) => fetchPage(plan.since.toISOString(), c),
        writePage: async (n: any[]) => { n.forEach((x) => seen.add(x.id)); return n.length; },
      });
      const res = nextResume(r, plan.since);
      state = {
        watermark: nextWatermark(r, new Date(T0 + i * 900_000)) ?? state.watermark,
        resume_cursor: res.cursor, resume_since: res.since,
      };
      if (r.complete) break;
    }
    eq('every order in the tied backlog is reached', seen.size, 2500);
    check('in a bounded number of runs', runs <= 3, String(runs));
    check('and the watermark only moves once it finishes',
      state.watermark.getTime() > T0, state.watermark.toISOString());
  }

  /* ---------------------------------------------- an interrupted backfill -- */
  section('A backfill interrupted midway, resumed');
  {
    await clean();
    const s = sync();
    function* lines(n: number) {
      for (let i = 0; i < n; i++) {
        const gid = `gid://shopify/Order/${30000 + i}`;
        yield JSON.stringify({ id: gid, name: `#BF-${i}`, createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z', currencyCode: 'EGP',
          totalPriceSet: { shopMoney: { amount: '100' } } });
        yield JSON.stringify({ id: `gid://shopify/LineItem/${i}`, __parentId: gid,
          title: 'Item', quantity: 1, originalTotalSet: { shopMoney: { amount: '100' } } });
      }
    }
    const asStream = async function* (xs: Iterable<string>) { for (const x of xs) yield x; };
    const all = [...lines(100)];     // 200 lines, 100 orders

    // Interrupted after 60 lines.
    const first = await streamBulkJsonl(asStream(all.slice(0, 60)), {
      batchSize: 10, windowSize: 20, onBatch: (o) => s.upsertOrders(o),
    });
    const afterFirst = Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n);
    check('the interrupted run wrote part of it', afterFirst === first.orders && afterFirst > 0,
      `${afterFirst} vs ${first.orders}`);

    // Resumed from where it stopped.
    const second = await streamBulkJsonl(asStream(all), {
      batchSize: 10, windowSize: 20, skipLines: 60, onBatch: (o) => s.upsertOrders(o),
    });
    const total = Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n);
    eq('together they cover every order exactly once', total, 100);
    eq('and the line items are not duplicated', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_order_line_items li
         JOIN sd_orders o ON o.id = li.order_id WHERE o.shop_id=$1`, [shopId])).n), 100);
    check('the resumed run read the whole file to verify the count',
      second.lines === 200, String(second.lines));

    await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
  }

  /* -------------------------------------------- many instances, one job -- */
  section('Four scheduler instances starting together');
  {
    await clean();
    let ran = 0;
    const job = async () => { ran++; await new Promise((r) => setTimeout(r, 60)); };
    const outcomes = await Promise.all(['a', 'b', 'c', 'd'].map((id) =>
      withJobLock('e2e:reconcile', job, { ttlMs: 60_000, owner: id })));

    eq('the job runs once', ran, 1);
    eq('and one instance reports it',
      outcomes.filter((o) => o.outcome === 'ran').length, 1);
    eq('the rest stand down', outcomes.filter((o) => o.outcome === 'held-elsewhere').length, 3);
  }

  section('Two workers draining a backlog together');
  {
    await clean();
    const fx = { publish: 0, refresh: 0, hydrate: 0, publishFails: false };
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await addEvent(payload({
        id: 9100 + i, admin_graphql_api_id: `gid://shopify/Order/${9100 + i}`,
        name: `#E2E-${9100 + i}`, order_number: 9100 + i,
        updated_at: `2026-06-02T${String(i % 24).padStart(2, '0')}:00:00Z`,
      }));
      if (id) ids.push(id);
    }
    const a = worker(processor(fx), 'wa');
    const b = worker(processor(fx), 'wb');
    const drain = async (w: WebhookWorker) => { while (await w.runOnce()) { /* go */ } };
    await Promise.all([drain(a), drain(b)]);

    const rows = await query<any>(
      `SELECT status, attempts FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);
    eq('every event is processed', rows.filter((r) => r.status === 'PROCESSED').length, 20);
    check('each exactly once', rows.every((r) => r.attempts === 1),
      JSON.stringify(rows.map((r) => r.attempts)));
    eq('and twenty orders exist, not forty', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n), 20);
  }

  /* ------------------------------------------------- what health reports -- */
  section('The health figures reflect what just happened');
  {
    await clean();
    await addEvent(payload({ id: 9200, admin_graphql_api_id: 'gid://shopify/Order/9200' }));
    await query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, attempts,
                                      next_attempt_at, payload)
       VALUES ($1,'e2e-dead','orders/updated','DEAD',$2,NULL,'{}'::jsonb)`,
      [shopId, MAX_ATTEMPTS]);

    const s = new SyncService(shops() as any, {
      source: { kind: 'live' },
      governor: { status: async () => ({ restoreRate: 100, available: 1900, maximum: 2000, throttledCalls24h: 0 }) },
      tokens: { status: async () => ({ source: 'env', expiresAt: null, refreshedAt: null }) },
    } as any, {} as any, {} as any, {} as any);

    const h = await s.health();
    eq('one waiting', h.queue.waiting, 1);
    eq('one given up', h.queue.dead, 1);
    check('and the dead one is listed for an operator',
      (await s.failedEvents(10, 0)).total === 1);
  }

  await clean();
  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_shops WHERE myshopify_domain = $1`, [SHOP]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });