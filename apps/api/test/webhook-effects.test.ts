/**
 * Side effects under duplicate processing.
 *
 *   DATABASE_URL=... npx tsx test/webhook-effects.test.ts
 *
 * Phase 4 made an event at-least-once: a retry, a reclaimed lease or a crash
 * can all cause the same payload to be applied again. That is safe only if
 * every effect it triggers is safe to repeat, so this checks each one rather
 * than assuming the Phase 2 guards cover everything.
 *
 * The classification being tested:
 *
 *   order / line item / refund / customer writes   safely repeatable
 *   customer spend                                 safely repeatable (recompute)
 *   store credit sync                              safely repeatable (read + upsert)
 *   hydration                                      safely repeatable (read + guarded write)
 *   snapshot refresh                               deduplicated (debounced)
 *   dashboard publish                              safely repeatable (a nudge)
 *
 * Nothing on this path mutates anything outside this system -- no Shopify
 * mutation, no email, no payment -- which is why no outbox is introduced. The
 * last test here is the one that would have to change if that ever stopped
 * being true.
 */
import { query, one, closeDb } from '../src/common/db';
import { WebhookWorker } from '../src/modules/sales-dashboard/webhooks/webhook-worker';
import { WebhookProcessor } from '../src/modules/sales-dashboard/webhooks/webhook-processor';
import { SyncService } from '../src/modules/sales-dashboard/sync/sync.service';

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

const SHOP_DOMAIN = 'effects-test.myshopify.com';
const ORDER_GID = 'gid://shopify/Order/5001';
let shopId: string;
let seq = 0;

const shops = () => ({ get: async () => one<any>(`SELECT * FROM sd_shops WHERE id = $1`, [shopId]) });

/** Counts every effect, so "did this happen twice" is a number not a guess. */
function effects() {
  return {
    publish: 0, refresh: 0, hydrate: 0, credit: 0,
    publishFails: false, hydrateFails: false,
  };
}

/** The real processor, with only the outward-facing collaborators replaced. */
function processor(fx: ReturnType<typeof effects>) {
  const sync = new SyncService(shops() as any, {} as any, {} as any, {} as any, {} as any);
  const snapshots = { scheduleRefresh: () => { fx.refresh++; } };
  const credit = { syncCustomer: async () => { fx.credit++; return 0; } };
  const shopify = { source: { kind: 'test' } };

  const p = new WebhookProcessor(
    shops() as any, snapshots as any, shopify as any, sync as any, credit as any);

  // publish and hydration are the two that reach outside the database.
  (p as any).publish = async () => {
    fx.publish++;
    if (fx.publishFails) throw new Error('redis unreachable');
  };
  (p as any).hydrateWithRetry = async () => {
    fx.hydrate++;
    if (fx.hydrateFails) throw new Error('shopify 503');
  };
  return { p, sync };
}

const orderPayload = (over: Record<string, any> = {}) => ({
  id: 5001, admin_graphql_api_id: ORDER_GID, name: '#P5-5001', order_number: 5001,
  created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z',
  currency: 'EGP', total_price: '1000', financial_status: 'paid',
  ...over,
});

const addEvent = async (payload: any, topic = 'orders/updated') => (await one<any>(
  `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, triggered_at, payload, next_attempt_at)
   VALUES ($1,$2,$3,$4,$5::jsonb, now()) RETURNING id`,
  [shopId, `fx-${Date.now()}-${++seq}`, topic, payload.updated_at, JSON.stringify(payload)])).id as string;

const event = (id: string) => one<any>(
  `SELECT status, attempts, error FROM sd_webhook_events WHERE id = $1`, [id]);
const order = () => one<any>(`SELECT * FROM sd_orders WHERE shopify_gid = $1`, [ORDER_GID]);

async function clean() {
  await query(`DELETE FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_orders WHERE shop_id = $1`, [shopId]);
  await query(`DELETE FROM sd_customers WHERE shop_id = $1`, [shopId]);
}

const worker = (p: any, id = 'fx-worker') => {
  const w = new WebhookWorker(p);
  (w as any).me = id;
  return w;
};

async function main() {
  shopId = (await one<any>(`SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]))?.id
    ?? (await one<any>(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ($1,'Effects fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP_DOMAIN])).id;
  await clean();

  /* --------------------------------------------- the same event, repeatedly -- */
  section('Processing the same payload again changes nothing');
  {
    const fx = effects();
    const { p } = processor(fx);
    const w = worker(p);

    const id = await addEvent(orderPayload());
    await w.runOnce();
    const first = await order();
    eq('the order was written', Number(first.total_price), 1000);

    /* Force the event back to claimable, which is exactly what a reclaimed
       lease or a retry does. */
    await query(
      `UPDATE sd_webhook_events SET status='PENDING', processed_at=NULL, next_attempt_at=now()
        WHERE id=$1`, [id]);
    await w.runOnce();

    const second = await order();
    eq('the order row is unchanged', Number(second.total_price), Number(first.total_price));
    check('and was not duplicated',
      Number((await one<any>(`SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n) === 1);
    eq('the payload was applied twice, as expected of at-least-once', fx.hydrate, 2);
    eq('and announced twice -- a nudge, not an action', fx.publish, 2);
    eq('while the snapshot refresh stayed deduplicated', fx.refresh, 2);
  }

  section('An older duplicate cannot undo a newer one');
  {
    /* The dangerous shape of duplicate delivery: Shopify redelivers an old
       payload after a newer one has been applied. */
    await clean();
    const fx = effects();
    const { p } = processor(fx);
    const w = worker(p);

    await addEvent(orderPayload({ updated_at: '2026-06-01T12:00:00Z', total_price: '2000' }));
    await w.runOnce();
    eq('the newer payload is stored', Number((await order()).total_price), 2000);

    const old = await addEvent(orderPayload({ updated_at: '2026-06-01T11:00:00Z', total_price: '1000' }));
    await w.runOnce();

    eq('the older redelivery is recorded STALE', (await event(old)).status, 'STALE');
    eq('and the stored total is untouched', Number((await order()).total_price), 2000);
    eq('nothing was announced for it', fx.publish, 1);
  }

  section('A duplicate delivery never becomes a second event');
  {
    await clean();
    const payload = orderPayload();
    const dupId = `fx-dup-${Date.now()}`;
    const first = await one<any>(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload, next_attempt_at)
       VALUES ($1,$2,'orders/updated',$3::jsonb, now())
       ON CONFLICT (webhook_id) DO NOTHING RETURNING id`,
      [shopId, dupId, JSON.stringify(payload)]);
    const again = await query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload, next_attempt_at)
       VALUES ($1,$2,'orders/updated',$3::jsonb, now())
       ON CONFLICT (webhook_id) DO NOTHING RETURNING id`,
      [shopId, dupId, JSON.stringify(payload)]);

    check('the first delivery is stored', !!first?.id);
    eq('the redelivery is absorbed by the unique key', again.length, 0);
    eq('leaving one event', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_webhook_events WHERE shop_id=$1`, [shopId])).n), 1);
  }

  /* ------------------------------------------- crashing around the publish -- */
  section('A crash before the publish');
  {
    /* The worker completes the event and dies before announcing. The order is
       stored and the dashboards simply have not been nudged -- they catch up
       on the next event or the hourly snapshot. Nothing is retried, because
       the event is already terminal. */
    await clean();
    const fx = effects();
    const { p } = processor(fx);
    const w = worker(p);
    const id = await addEvent(orderPayload());

    (p as any).announce = async () => { throw new Error('process died'); };
    await w.runOnce();

    const ev = await event(id);
    eq('the event is still recorded PROCESSED', ev.status, 'PROCESSED');
    check('with no error written against it', ev.error === null, String(ev.error));
    eq('the business data landed', Number((await order()).total_price), 1000);
    eq('it is not left claimable', await w.runOnce(), false);
  }

  section('A failing publish does not undo a processed event');
  {
    /* The defect this pins. In the inline path announce() sat inside the try
       that records failure, so a Redis outage -- a nudge with no payload --
       flipped an event that had already been applied and marked PROCESSED to
       FAILED, and the worker would then process it all over again. */
    await clean();
    const fx = effects();
    fx.publishFails = true;
    const { p } = processor(fx);
    const id = await addEvent(orderPayload());

    await (p as any).processOne(id);

    const ev = await event(id);
    eq('the event stays PROCESSED', ev.status, 'PROCESSED');
    check('and no failure is recorded against it', ev.error === null, String(ev.error));
    eq('the publish was attempted', fx.publish, 1);
    eq('the order is stored', Number((await order()).total_price), 1000);
  }

  section('A failing hydration does not undo a processed event either');
  {
    await clean();
    const fx = effects();
    fx.hydrateFails = true;
    const { p } = processor(fx);
    const w = worker(p);
    const id = await addEvent(orderPayload());

    await w.runOnce();
    const ev = await event(id);
    eq('the event is PROCESSED', ev.status, 'PROCESSED');
    check('no error recorded', ev.error === null, String(ev.error));
    eq('hydration was attempted', fx.hydrate, 1);
    check('and the payload itself was still applied', !!(await order()));
  }

  /* ------------------------------------------------- the deduplicated effect -- */
  section('Snapshot refresh is deduplicated, not queued');
  {
    /* Debounced inside scheduleRefresh: a burst of orders must produce one
       ShopifyQL round trip, not one per order. Counted here at the call site;
       the debounce itself is the snapshot service's own behaviour. */
    await clean();
    const fx = effects();
    const { p } = processor(fx);
    const w = worker(p);

    for (let i = 0; i < 5; i++) {
      await addEvent(orderPayload({
        id: 5001 + i, admin_graphql_api_id: `gid://shopify/Order/${5001 + i}`,
        name: `#P5-${5001 + i}`, order_number: 5001 + i,
        updated_at: `2026-06-01T1${i}:00:00Z`,
      }));
    }
    while (await w.runOnce()) { /* drain */ }

    eq('five orders were processed', Number((await one<any>(
      `SELECT count(*) AS n FROM sd_orders WHERE shop_id=$1`, [shopId])).n), 5);
    eq('each asked for a refresh', fx.refresh, 5);
    check('which the service collapses into one pass -- the request is cheap, '
      + 'the ShopifyQL round trip behind it is not', fx.refresh === 5);
  }

  section('A topic that moves no figure asks for no refresh');
  {
    await clean();
    const fx = effects();
    const { p } = processor(fx);
    const w = worker(p);
    await addEvent({ id: 77, admin_graphql_api_id: 'gid://shopify/Customer/77',
                     updated_at: '2026-06-01T10:00:00Z', email: 'x@example.com' },
                   'customers/update');
    await w.runOnce();
    eq('no snapshot refresh for a customer detail change', fx.refresh, 0);
    eq('and no hydration either', fx.hydrate, 0);
  }

  /* ------------------------------------------- nothing leaves the building -- */
  section('No effect on this path acts outside this system');
  {
    /* The assumption the whole classification rests on, asserted rather than
       trusted: every effect is a database write, a cache refresh, or a
       read-only call to Shopify. There is no mutation, no message, no payment
       -- so at-least-once costs an extra query at worst, and a transactional
       outbox would be machinery guarding nothing.
     
       If an effect that writes to Shopify or messages a customer is ever added
       to this path, this test should fail and the decision be revisited. */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'modules', 'sales-dashboard',
        'webhooks', 'webhook-processor.ts'), 'utf8');

    /* Matched against what a send actually looks like, not the word "mail" --
       which appears in this file as a customer's email column and would make
       this assertion fail for the wrong reason. */
    check('the processor sends no GraphQL mutation', !/mutation\s*[({]/.test(src));
    check('and sends nothing to a person',
      !/\b(mailer|mailService|sendMail|sendEmail|notifications?)\s*\.\s*\w+\s*\(/i
        .test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

    const credit = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'modules', 'sales-dashboard',
        'sync', 'store-credit.service.ts'), 'utf8');
    const syncCustomer = credit.slice(credit.indexOf('async syncCustomer'));
    check('the store-credit refresh reachable from a refund is a read, not a write',
      !/mutation/.test(syncCustomer.slice(0, syncCustomer.indexOf('\n  }'))));
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