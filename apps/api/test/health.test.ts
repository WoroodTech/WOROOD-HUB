/**
 * Health reporting and the dead-letter screen.
 *
 *   DATABASE_URL=... npx tsx test/health.test.ts
 *
 * The defect being guarded against is specific: the queue panel reported
 * `active: 0, failed: 0, completed: 0` as literal zeros, beside a `waiting`
 * read from a Redis list that stopped being the queue when the worker moved to
 * PostgreSQL. So the tests build a table whose true state is known and check
 * each number against it -- a hardcoded zero cannot pass a test that puts three
 * dead events in the table and asks how many there are.
 *
 * Replay is checked for what it does to the row, not for processing: it must
 * hand the event back to the ordinary worker path rather than apply anything
 * itself.
 */
import { query, one, closeDb } from '../src/common/db';
import { SyncService, isResourceHealthy } from '../src/modules/sales-dashboard/sync/sync.service';
import { WebhookWorker } from '../src/modules/sales-dashboard/webhooks/webhook-worker';
import { MAX_ATTEMPTS } from '../src/modules/sales-dashboard/webhooks/webhook-lifecycle';

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

const SHOP_DOMAIN = 'health-test.myshopify.com';
let shopId: string;
let seq = 0;

const svc = () => {
  const shops = { get: async () => one<any>(`SELECT * FROM sd_shops WHERE id = $1`, [shopId]) };
  /* health() reads the cost governor and the token state as well as the
     database. Stubbed rather than mocked away, because the response shape is
     part of what is being checked. */
  const shopify = {
    source: { kind: 'live' },
    governor: { status: async () => ({ restoreRate: 100, available: 1900, maximum: 2000, throttledCalls24h: 0 }) },
    tokens: { status: async () => ({ source: 'env', expiresAt: null, refreshedAt: null }) },
  };
  return new SyncService(shops as any, shopify as any, {} as any, {} as any, {} as any);
};

const add = async (over: Record<string, any> = {}) => (await one<any>(
  `INSERT INTO sd_webhook_events
     (shop_id, webhook_id, topic, status, attempts, received_at, processed_at,
      next_attempt_at, last_attempt_at, lease_owner, lease_expires_at, error, payload)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
  [shopId, `h-${Date.now()}-${++seq}`, over.topic ?? 'orders/updated',
   over.status ?? 'PENDING', over.attempts ?? 0,
   over.received_at ?? new Date(), over.processed_at ?? null,
   over.next_attempt_at === undefined ? new Date() : over.next_attempt_at,
   over.last_attempt_at ?? null, over.lease_owner ?? null, over.lease_expires_at ?? null,
   over.error ?? null,
   over.payload === null ? null : JSON.stringify(over.payload ?? { id: 1 })])).id as string;

const clean = () => query(`DELETE FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);

async function main() {
  shopId = (await one<any>(`SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]))?.id
    ?? (await one<any>(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone, plan_name, api_version)
       VALUES ($1,'Health fixture','EGP','Africa/Cairo','Advanced','2024-10') RETURNING id`,
      [SHOP_DOMAIN])).id;
  await clean();

  /* ------------------------------------------------------ the real figures -- */
  section('Every queue figure is measured, not assumed');
  {
    const hour = 3600_000;
    // A table whose true state is known exactly.
    await add({ status: 'PENDING' });                                        // waiting
    await add({ status: 'PENDING' });                                        // waiting
    await add({ status: 'PROCESSING', lease_owner: 'w1',
                lease_expires_at: new Date(Date.now() + hour) });            // processing, live
    await add({ status: 'PROCESSING', lease_owner: 'w2',
                lease_expires_at: new Date(Date.now() - 60_000) });          // processing, expired
    await add({ status: 'FAILED', attempts: 2,
                next_attempt_at: new Date(Date.now() + hour) });             // retrying
    await add({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null }); // dead
    await add({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null }); // dead
    await add({ status: 'PROCESSED', processed_at: new Date(), next_attempt_at: null });
    await add({ status: 'STALE', processed_at: new Date(), next_attempt_at: null });
    // Outside the 24h window: counted in neither received nor completed.
    await add({ status: 'PROCESSED', received_at: new Date(Date.now() - 48 * hour),
                processed_at: new Date(Date.now() - 48 * hour), next_attempt_at: null });

    const h = await svc().health();
    const q = h.queue;

    eq('waiting', q.waiting, 2);
    eq('processing', q.processing, 2);
    eq('retrying', q.retrying, 1);
    eq('dead', q.dead, 2);
    eq('completed in the window', q.completed24h, 2);
    eq('expired leases are identified separately from processing',
      q.expiredLeases, 1);
    eq('and the attempt ceiling is reported so a count can be read',
      q.maxAttempts, MAX_ATTEMPTS);

    /* The three that were hardcoded. Asserted as "not zero" as well as by
       value, because a zero here used to be the answer regardless. */
    check('processing is no longer a hardcoded zero', q.processing !== 0);
    check('dead is no longer a hardcoded zero', q.dead !== 0);
    check('completed is no longer a hardcoded zero', q.completed24h !== 0);

    eq('events received in the window', h.webhooks.received24h, 9);
    eq('stale within the window', h.webhooks.stale24h, 1);
  }

  section('The age of the oldest due event');
  {
    await clean();
    const h0 = await svc().health();
    check('nothing due means no age to report', h0.queue.oldestDueSeconds === null,
      String(h0.queue.oldestDueSeconds));

    await add({ status: 'PENDING', next_attempt_at: new Date(Date.now() - 90 * 60_000) });
    await add({ status: 'PENDING', next_attempt_at: new Date(Date.now() - 60_000) });
    // Scheduled for later: due in the future, so not part of the backlog yet.
    await add({ status: 'FAILED', next_attempt_at: new Date(Date.now() + 3600_000) });

    const h = await svc().health();
    check('the oldest due event sets the age',
      h.queue.oldestDueSeconds! >= 5400 && h.queue.oldestDueSeconds! < 5500,
      String(h.queue.oldestDueSeconds));
    eq('an event not yet due is not counted as waiting', h.queue.waiting, 2);
    eq('it is counted as retrying instead', h.queue.retrying, 1);
    check('and a count alone could not have told those apart',
      h.queue.waiting + h.queue.retrying === 3);
  }

  section('Each resource is judged against its own cadence');
  {
    /* The blanket twenty-four-hour threshold put orders_backfill permanently in
       the red. It is a one-time import of the store's history -- it ran once,
       brought ninety-six thousand orders, and is supposed to have an old
       timestamp. A row that can only ever be red teaches people to ignore the
       colour, and then reconciliation going red means nothing either. */
    const day = 24 * 3600;

    check('a backfill that succeeded three weeks ago is healthy',
      isResourceHealthy('orders_backfill', 'OK', 21 * day) === true);
    check('and one that succeeded a year ago still is -- age says nothing about it',
      isResourceHealthy('orders_backfill', 'OK', 365 * day) === true);
    check('but a FAILED backfill is not',
      isResourceHealthy('orders_backfill', 'ERROR', 60) === false);
    check('nor one that has never completed',
      isResourceHealthy('orders_backfill', 'OK', null) === false);

    /* Reconciliation runs every fifteen minutes, so a day of grace hid a
       genuinely stuck sync for most of that day. */
    check('reconciliation is healthy half an hour after a success',
      isResourceHealthy('orders', 'OK', 1800) === true);
    check('and unhealthy after two hours, not after a day',
      isResourceHealthy('orders', 'OK', 2 * 3600) === false);

    /* The watchdog re-verifies webhooks at 03:00 Cairo, so a day exactly would
       flap red in the hours before each run. */
    check('webhooks verified yesterday are still healthy',
      isResourceHealthy('webhooks', 'OK', 25 * 3600) === true);
    check('but not after two days', isResourceHealthy('webhooks', 'OK', 49 * 3600) === false);

    check('customers tolerate a quiet weekend',
      isResourceHealthy('customers', 'OK', 30 * 3600) === true);

    check('an unlisted resource keeps the old blanket day',
      isResourceHealthy('something_new', 'OK', 23 * 3600) === true
        && isResourceHealthy('something_new', 'OK', 25 * 3600) === false);
  }

  section('Reconciliation and backfill status come through');
  {
    await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);
    await query(
      `INSERT INTO sd_sync_state (shop_id, resource, status, last_run_at, last_ok_at, records, watermark)
       VALUES ($1,'orders','OK', now(), now() - interval '5 minutes', 42, now() - interval '5 minutes'),
              ($1,'orders_backfill','OK', now() - interval '2 days',
               now() - interval '2 days', 9000, NULL)`, [shopId]);

    const h = await svc().health();
    const orders = h.resources.find((r) => r.resource === 'orders');
    const backfill = h.resources.find((r) => r.resource === 'orders_backfill');

    check('reconciliation is reported', !!orders);
    eq('with its last success', typeof orders!.lastOkAt, 'string');
    check('and judged healthy while it is recent', orders!.healthy === true);

    check('the backfill is reported', !!backfill);
    eq('with how much it brought', backfill!.records, 9000);
    check('and is NOT called stale for being two days old -- it is a one-time import',
      backfill!.healthy === true, String(backfill!.lagSeconds));
  }

  /* ------------------------------------------------------- the dead letter -- */
  section('Inspecting events that gave up');
  {
    await clean();
    for (let i = 0; i < 5; i++) {
      await add({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null,
                  error: `boom ${i}`, topic: 'orders/updated' });
    }
    await add({ status: 'FAILED', attempts: 2, error: 'transient' });
    await add({ status: 'PROCESSED', processed_at: new Date() });

    const page = await svc().failedEvents(3, 0);
    eq('the page is the size asked for', page.events.length, 3);
    eq('the total counts every failure, not just the page', page.total, 6);
    check('processed events are not in it',
      page.events.every((e) => e.status === 'DEAD' || e.status === 'FAILED'));
    check('the error is shown, because that is what the screen is for',
      page.events.every((e) => e.error !== null));
    check('and whether a payload still exists', page.events.every((e) => e.hasPayload === true));

    const second = await svc().failedEvents(3, 3);
    eq('the next page holds the rest', second.events.length, 3);
    check('with no overlap',
      new Set([...page.events, ...second.events].map((e) => e.id)).size === 6);
  }

  section('No customer data leaves through the failure screen');
  {
    await clean();
    /* A payload with the things a real order carries. None of it may appear in
       the response: deciding whether to replay needs the topic, the timing, the
       attempt count and the error -- not a customer's address. */
    await add({
      status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null, error: 'failed',
      payload: {
        id: 123, email: 'customer@example.com',
        customer: { first_name: 'Mona', last_name: 'Adel', phone: '+201000000000' },
        shipping_address: { address1: '12 Nile St', city: 'Cairo', phone: '+201000000000' },
        line_items: [{ title: 'Silk scarf', price: '1200' }],
      },
    });

    const page = await svc().failedEvents(10, 0);
    const text = JSON.stringify(page);
    check('no email address', !/customer@example\.com/.test(text));
    check('no customer name', !/Mona|Adel/.test(text));
    check('no phone number', !/\+201000000000/.test(text));
    check('no address', !/Nile St/.test(text));
    check('no line items', !/Silk scarf/.test(text));
    check('but the fact that a payload exists is reported',
      page.events[0].hasPayload === true);
    check('along with the error', page.events[0].error === 'failed');
  }

  /* -------------------------------------------------------------- replay -- */
  section('Replay hands the event back to the worker');
  {
    await clean();
    const id = await add({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null,
                           error: 'shopify 503', processed_at: new Date() });

    const result = await svc().replayEvent(id);
    eq('it is queued', result.queued, true);
    eq('as PENDING', result.status, 'PENDING');

    const row = await one<any>(
      `SELECT status, attempts, next_attempt_at, error, lease_owner, processed_at
         FROM sd_webhook_events WHERE id = $1`, [id]);
    eq('the row is back in the queue', row.status, 'PENDING');
    eq('with a fresh attempt budget', row.attempts, 0);
    check('due immediately', row.next_attempt_at !== null);
    check('holding no lease', row.lease_owner === null);
    check('the previous error is kept, because the history is the point',
      row.error === 'shopify 503', String(row.error));

    /* The requirement that matters: replay must not process anything itself.
       The worker picks it up through the same claim, lease and completion it
       uses for every other event. */
    let applied = 0;
    const worker = new WebhookWorker({
      applyEvent: async () => { applied++; return true; },
      announce: async () => undefined,
    } as any);
    (worker as any).me = 'replay-worker';

    eq('the ordinary worker claims it', await worker.runOnce(), true);
    eq('and applies it once', applied, 1);
    const after = await one<any>(
      `SELECT status, attempts FROM sd_webhook_events WHERE id = $1`, [id]);
    eq('reaching a terminal state the normal way', after.status, 'PROCESSED');
    eq('with the attempt counted from the reset', after.attempts, 1);
  }

  section('What cannot be replayed');
  {
    await clean();
    const sync = svc();

    const processed = await add({ status: 'PROCESSED', processed_at: new Date() });
    let err = '';
    try { await sync.replayEvent(processed); } catch (e: any) { err = e.message; }
    check('a processed event is refused', /only events that have failed/i.test(err), err);

    const inflight = await add({ status: 'PROCESSING', lease_owner: 'w1',
                                 lease_expires_at: new Date(Date.now() + 60_000) });
    err = '';
    try { await sync.replayEvent(inflight); } catch (e: any) { err = e.message; }
    check('an event a worker is holding is refused', /PROCESSING/.test(err), err);

    const trimmed = await add({ status: 'DEAD', attempts: MAX_ATTEMPTS,
                                next_attempt_at: null, payload: null });
    err = '';
    try { await sync.replayEvent(trimmed); } catch (e: any) { err = e.message; }
    check('an event whose payload retention cleared is refused, and says why',
      /retention/i.test(err), err);

    err = '';
    try { await sync.replayEvent('00000000-0000-0000-0000-000000000000'); }
    catch (e: any) { err = e.message; }
    check('an unknown id is a not-found', /no such webhook event/i.test(err), err);
  }

  section('Replaying twice does not queue it twice');
  {
    await clean();
    const id = await add({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null });
    const first = await svc().replayEvent(id);
    eq('the first queues it', first.queued, true);

    let second: any = null, threw = '';
    try { second = await svc().replayEvent(id); } catch (e: any) { threw = e.message; }
    check('the second is refused rather than queueing it again',
      threw !== '' || second?.queued === false, `${threw} ${JSON.stringify(second)}`);
    const n = await one<any>(
      `SELECT count(*) AS n FROM sd_webhook_events WHERE id = $1 AND status = 'PENDING'`, [id]);
    eq('and there is still one row', Number(n.n), 1);
  }

  /* ----------------------------------------------------- a big event table -- */
  section('The queries stay bounded on a large table');
  {
    await clean();
    /* Enough rows that a careless query shows up. The figures must still be
       right and the page must still be the size asked for. */
    await query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, attempts,
                                      received_at, processed_at, next_attempt_at, payload)
       SELECT $1, 'bulk-' || g, 'orders/updated',
              CASE WHEN g % 50 = 0 THEN 'DEAD' ELSE 'PROCESSED' END,
              CASE WHEN g % 50 = 0 THEN $2::int ELSE 1 END,
              now() - (g || ' seconds')::interval,
              now() - (g || ' seconds')::interval,
              NULL, '{"id":1}'::jsonb
         FROM generate_series(1, 20000) g`, [shopId, MAX_ATTEMPTS]);

    const started = Date.now();
    const h = await svc().health();
    const healthMs = Date.now() - started;

    eq('the dead are counted correctly among twenty thousand', h.queue.dead, 400);
    check('and the health query stays quick', healthMs < 3000, `${healthMs}ms`);

    const t0 = Date.now();
    const page = await svc().failedEvents(25, 0);
    const pageMs = Date.now() - t0;
    eq('the page is bounded', page.events.length, 25);
    eq('while the total is the true count', page.total, 400);
    check('and the page query stays quick', pageMs < 3000, `${pageMs}ms`);

    const capped = await svc().failedEvents(5000, 0);
    check('a caller cannot ask for an unbounded page',
      capped.events.length <= 100, String(capped.events.length));
  }

  await clean();
  await query(`DELETE FROM sd_sync_state WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });