/**
 * The bulk import: memory, resumption, and running only once.
 *
 *   DATABASE_URL=... npx tsx test/backfill.test.ts
 *
 * Two halves. The reassembly is exercised against generated JSONL with no
 * network and no database, because what matters about it is memory and the
 * handling of malformed and orphaned rows. The claim and progress are
 * exercised against real PostgreSQL, because they are the database's job.
 *
 * No bulk operation is ever started. The Shopify side is a stub.
 */
import { query, one, closeDb } from '../src/common/db';
import { streamBulkJsonl, linesOf } from '../src/modules/sales-dashboard/sync/bulk-stream';
import { BackfillService, BackfillIncomplete } from '../src/modules/sales-dashboard/sync/backfill.service';

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

const SHOP_DOMAIN = 'backfill-test.myshopify.com';
let shopId: string;

/** Generated JSONL in Shopify's shape: a parent, then its children. */
function* exportLines(orders: number, linesPerOrder = 2) {
  for (let i = 0; i < orders; i++) {
    const gid = `gid://shopify/Order/${100000 + i}`;
    yield JSON.stringify({
      id: gid, name: `#B-${100000 + i}`,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      currencyCode: 'EGP',
      totalPriceSet: { shopMoney: { amount: '100' } },
    });
    for (let c = 1; c < linesPerOrder; c++) {
      yield JSON.stringify({
        id: `gid://shopify/LineItem/${i}-${c}`, __parentId: gid,
        title: `Item ${c}`, quantity: 1,
        originalTotalSet: { shopMoney: { amount: '50' } },
      });
    }
  }
}

const asStream = async function* (lines: Iterable<string>) {
  for (const l of lines) yield l;
};

async function main() {
  /* ------------------------------------------------ memory is bounded -- */
  section('A large export is processed in batches, not accumulated');
  {
    const ORDERS = 20_000;
    let maxBatch = 0, batches = 0, seen = 0;
    /* Watched rather than asserted on heap figures, which are too noisy to
       assert: what is provable is that no batch ever exceeded its bound and
       that the whole thing was never held at once. */
    const r = await streamBulkJsonl(asStream(exportLines(ORDERS, 3)), {
      batchSize: 200, windowSize: 500,
      onBatch: async (orders) => {
        batches++; seen += orders.length;
        maxBatch = Math.max(maxBatch, orders.length);
        return orders.length;
      },
    });

    eq('every order is handed on', r.orders, ORDERS);
    eq('and written', r.written, ORDERS);
    eq('nothing was seen twice', seen, ORDERS);
    check('in many batches, not one', batches >= ORDERS / 200, String(batches));
    check('and no batch exceeded its bound', maxBatch <= 200, String(maxBatch));
    eq('the line count matches the export', r.lines, ORDERS * 3);
    eq('with no orphans', r.orphans, 0);
  }

  section('Children are attached to their parent');
  {
    const r0: any[] = [];
    const r = await streamBulkJsonl(asStream(exportLines(5, 4)), {
      batchSize: 10, windowSize: 20,
      onBatch: async (orders) => { r0.push(...orders); return orders.length; },
    });
    eq('five orders', r.orders, 5);
    eq('each with its three line items', r0.map((o) => o.lineItems.nodes.length), [3, 3, 3, 3, 3]);
    check('and the line items belong to the right order',
      r0.every((o) => o.lineItems.nodes.every((li: any) => li.__parentId === o.id)));
  }

  section('Refunds and line items are told apart by shape');
  {
    const lines = [
      JSON.stringify({ id: 'gid://shopify/Order/1', name: '#1', createdAt: '2026-01-01T00:00:00Z',
                       updatedAt: '2026-01-01T00:00:00Z', currencyCode: 'EGP' }),
      JSON.stringify({ id: 'gid://shopify/LineItem/1', __parentId: 'gid://shopify/Order/1',
                       title: 'Roses', quantity: 2 }),
      JSON.stringify({ id: 'gid://shopify/Refund/1', __parentId: 'gid://shopify/Order/1',
                       createdAt: '2026-01-02T00:00:00Z',
                       totalRefundedSet: { shopMoney: { amount: '25' } } }),
    ];
    let order: any;
    await streamBulkJsonl(asStream(lines), {
      batchSize: 10, windowSize: 10,
      onBatch: async (o) => { order = o[0]; return o.length; },
    });
    eq('the line item went to lineItems', order.lineItems.nodes.length, 1);
    eq('the refund went to refunds', order.refunds.length, 1);
    eq('and the refund kept its amount',
      order.refunds[0].totalRefundedSet.shopMoney.amount, '25');
  }

  section('A child arriving before its parent still lands');
  {
    const lines = [
      JSON.stringify({ id: 'gid://shopify/LineItem/9', __parentId: 'gid://shopify/Order/9',
                       title: 'Early', quantity: 1 }),
      JSON.stringify({ id: 'gid://shopify/Order/9', name: '#9', createdAt: '2026-01-01T00:00:00Z',
                       updatedAt: '2026-01-01T00:00:00Z', currencyCode: 'EGP' }),
    ];
    let order: any;
    const r = await streamBulkJsonl(asStream(lines), {
      batchSize: 10, windowSize: 10,
      onBatch: async (o) => { order = o[0]; return o.length; },
    });
    eq('the order is reassembled', r.orders, 1);
    eq('with the early child attached', order.lineItems.nodes.length, 1);
    eq('and nothing orphaned', r.orphans, 0);
  }

  section('Malformed input loses only itself');
  {
    const good = [...exportLines(3, 2)];
    const lines = [good[0], '{ not json', good[1], '', good[2], 'null-ish', good[3], good[4], good[5]];
    const r = await streamBulkJsonl(asStream(lines), {
      batchSize: 10, windowSize: 10,
      onBatch: async (o) => o.length,
      log: { warn: () => undefined },
    });
    eq('the unparseable lines are counted', r.malformed, 2);
    eq('and the three orders still arrive', r.orders, 3);
  }

  section('A child whose parent never appears is counted, not lost silently');
  {
    const lines = [
      JSON.stringify({ id: 'gid://shopify/Order/1', name: '#1', createdAt: '2026-01-01T00:00:00Z',
                       updatedAt: '2026-01-01T00:00:00Z', currencyCode: 'EGP' }),
      JSON.stringify({ id: 'gid://shopify/LineItem/x', __parentId: 'gid://shopify/Order/NEVER',
                       title: 'Orphan', quantity: 1 }),
    ];
    const r = await streamBulkJsonl(asStream(lines), {
      batchSize: 10, windowSize: 10,
      onBatch: async (o) => o.length,
      log: { warn: () => undefined },
    });
    eq('one order', r.orders, 1);
    eq('one orphan reported', r.orphans, 1);
  }

  section('Resuming skips what the interrupted run already did');
  {
    const lines = [...exportLines(10, 2)];       // 20 lines
    const first: any[] = [];
    await streamBulkJsonl(asStream(lines.slice(0, 10)), {
      batchSize: 100, windowSize: 100,
      onBatch: async (o) => { first.push(...o); return o.length; },
    });
    eq('the interrupted run handled five orders', first.length, 5);

    const second: any[] = [];
    const r = await streamBulkJsonl(asStream(lines), {
      batchSize: 100, windowSize: 100, skipLines: 10,
      onBatch: async (o) => { second.push(...o); return o.length; },
    });
    eq('the resumed run handles the rest', second.length, 5);
    eq('and reads the whole file to count it', r.lines, 20);
    check('together covering every order once',
      new Set([...first, ...second].map((o) => o.id)).size === 10);
  }

  section('A byte stream becomes lines without holding the file');
  {
    const text = [...exportLines(3, 2)].join('\n');
    const chunks = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(Buffer.from(text.slice(i, i + 7)));
    const out: string[] = [];
    for await (const l of linesOf(asStream(chunks as any))) out.push(l);
    eq('split arbitrarily, the lines are still whole', out.length, 6);
    check('and each parses', out.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  }

  /* --------------------------------------------- claim, progress, resume -- */
  shopId = (await one<any>(`SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]))?.id
    ?? (await one<any>(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ($1,'Backfill fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP_DOMAIN])).id;
  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);

  const claim = () => one<any>(
    `INSERT INTO sd_sync_state (shop_id, resource, status, last_run_at, records)
     VALUES ($1, 'orders_backfill', 'RUNNING', now(), 0)
     ON CONFLICT (shop_id, resource) DO UPDATE
       SET status = 'RUNNING', last_run_at = now(), error = NULL
     WHERE sd_sync_state.status <> 'RUNNING'
        OR sd_sync_state.last_run_at < now() - interval '30 minutes'
     RETURNING progress`, [shopId]);

  section('Only one backfill runs at a time');
  {
    const first = await claim();
    check('the first caller takes it', !!first);
    const second = await claim();
    check('a second caller is refused', second === undefined || second === null, JSON.stringify(second));

    /* Two arriving at the same instant, which is the case a process-local flag
       cannot cover: the API and the worker, or two API instances. */
    await query(`UPDATE sd_sync_state SET status='OK' WHERE shop_id=$1 AND resource='orders_backfill'`, [shopId]);
    const both = await Promise.all([claim(), claim(), claim(), claim()]);
    eq('exactly one of four concurrent callers wins',
      both.filter((r) => r !== undefined && r !== null).length, 1);
  }

  section('A crashed backfill does not block the next one for ever');
  {
    await query(
      `UPDATE sd_sync_state SET status='RUNNING', last_run_at = now() - interval '31 minutes'
        WHERE shop_id=$1 AND resource='orders_backfill'`, [shopId]);
    check('a stale claim can be taken over', !!(await claim()));

    await query(
      `UPDATE sd_sync_state SET status='RUNNING', last_run_at = now() - interval '5 minutes'
        WHERE shop_id=$1 AND resource='orders_backfill'`, [shopId]);
    const held = await claim();
    check('but a recent one still holds', held === undefined || held === null);
  }

  section('Progress survives an interruption, and clears on success');
  {
    await query(
      `UPDATE sd_sync_state
          SET status='ERROR', error='killed', progress = $2::jsonb
        WHERE shop_id=$1 AND resource='orders_backfill'`,
      [shopId, JSON.stringify({ operationId: 'gid://shopify/BulkOperation/7',
                                linesProcessed: 1234, written: 400, phase: 'streaming' })]);

    const row = await one<any>(
      `SELECT status, progress FROM sd_sync_state WHERE shop_id=$1 AND resource='orders_backfill'`,
      [shopId]);
    eq('the failure is recorded', row.status, 'ERROR');
    eq('with where it got to', row.progress.linesProcessed, 1234);
    eq('and which export it was reading', row.progress.operationId, 'gid://shopify/BulkOperation/7');

    const taken = await claim();
    check('the retry takes the claim', !!taken);
    eq('and is handed the progress to resume from', taken.progress.linesProcessed, 1234);

    // Completion clears it: there is nothing left to resume.
    await query(
      `UPDATE sd_sync_state SET status='OK', last_ok_at=now(), records=9000, progress=NULL
        WHERE shop_id=$1 AND resource='orders_backfill'`, [shopId]);
    const done = await one<any>(
      `SELECT status, records, progress FROM sd_sync_state
        WHERE shop_id=$1 AND resource='orders_backfill'`, [shopId]);
    eq('success is recorded', done.status, 'OK');
    eq('with the total', Number(done.records), 9000);
    check('and no progress left behind', done.progress === null);
  }

  /* ------------------------------------------- a truncated download fails -- */
  section('A truncated download is not reported as success');
  {
    /* The check that did not exist. One JSONL line is one object, so the
       export's own objectCount and the lines read must agree -- and when they
       do not, nothing else reveals it: a body cut short parses cleanly and
       looks exactly like a smaller store. */
    const full = [...exportLines(10, 2)];            // 20 objects
    const truncated = full.slice(0, 13);             // the tail is lost

    const shopify = {
      source: {
        kind: 'live',
        graphql: async () => ({
          node: {
            id: 'gid://shopify/BulkOperation/9', status: 'COMPLETED',
            objectCount: full.length, url: 'https://example.invalid/bulk.jsonl',
          },
        }),
      },
    };
    const svc = new BackfillService(shopify as any);
    (svc as any).download = async (_url: string, onBatch: any, o: any = {}) =>
      streamBulkJsonl(asStream(truncated), {
        batchSize: 100, windowSize: 100, skipLines: o.skipLines, onBatch, onProgress: o.onProgress,
      });

    let err: any = null;
    try {
      await svc.waitAndIngest('gid://shopify/BulkOperation/9', async (o) => o.length);
    } catch (e) { err = e; }

    check('it fails rather than returning a total', err instanceof BackfillIncomplete,
      err?.constructor?.name ?? 'no error');
    check('and says how far short it fell', /13 of 20/.test(err?.message ?? ''), err?.message);
    eq('naming the operation so it can be resumed', err?.operationId, 'gid://shopify/BulkOperation/9');

    // The same stream, whole, succeeds.
    (svc as any).download = async (_url: string, onBatch: any, o: any = {}) =>
      streamBulkJsonl(asStream(full), {
        batchSize: 100, windowSize: 100, skipLines: o.skipLines, onBatch, onProgress: o.onProgress,
      });
    const ok = await svc.waitAndIngest('gid://shopify/BulkOperation/9', async (o) => o.length);
    eq('a complete download reports its orders', ok.orders, 10);
    eq('and the object count it checked against', ok.objectCount, 20);
  }

  section('Replaying the same export writes the same orders, not more');
  {
    /* The import uses the ordinary order-writing path, so a replay converges
       rather than duplicating -- which is what makes resumption safe to be
       approximate about. */
    const { SyncService } = require('../src/modules/sales-dashboard/sync/sync.service');
    const shops = { get: async () => one<any>(`SELECT * FROM sd_shops WHERE id = $1`, [shopId]) };
    const sync = new SyncService(shops as any, {} as any, {} as any, {} as any, {} as any);

    await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
    const run = () => streamBulkJsonl(asStream(exportLines(25, 3)), {
      batchSize: 10, windowSize: 20,
      onBatch: (orders) => sync.upsertOrders(orders),
    });

    const first = await run();
    const afterFirst = Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n);
    const second = await run();
    const afterSecond = Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n);

    eq('the first pass writes them', first.written, 25);
    eq('the rows exist', afterFirst, 25);
    eq('the replay writes the same count', second.written, 25);
    eq('and the table is unchanged', afterSecond, 25);

    const lines = Number((await one<any>(
      `SELECT count(*) AS n FROM sd_order_line_items li
         JOIN sd_orders o ON o.id = li.order_id WHERE o.shop_id = $1`, [shopId])).n);
    eq('line items are not duplicated either', lines, 50);

    await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
  }

  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });