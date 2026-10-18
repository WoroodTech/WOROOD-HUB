/**
 * The durable worker, against a real PostgreSQL.
 *
 *   DATABASE_URL=... npx tsx test/webhook-worker.test.ts
 *
 * Every property here is a property of concurrency or of crash timing, and
 * neither can be shown with a mock. Two workers racing for one event, a lease
 * running out mid-flight, a process dying between the business write and the
 * status write: these are the cases the old path got wrong, so they are staged
 * literally rather than reasoned about.
 *
 * The processor is replaced with a stub whose behaviour each test chooses --
 * apply, be slow, throw. What is under test is the worker's claim, lease and
 * retry handling, not what `orders/updated` means; that has its own tests.
 */
import { query, one, closeDb } from '../src/common/db';
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

const SHOP_DOMAIN = 'worker-test.myshopify.com';
let shopId: string;
let seq = 0;

/** A processor stub. Each test says what applying an event should do. */
function stub(behaviour: {
  apply?: (topic: string, payload: any) => Promise<boolean>;
  announce?: (topic: string, payload: any) => Promise<void>;
} = {}) {
  const calls = { applied: 0, announced: 0 };
  return {
    calls,
    applyEvent: async (topic: string, payload: any) => {
      calls.applied++;
      return behaviour.apply ? behaviour.apply(topic, payload) : true;
    },
    announce: async (topic: string, payload: any) => {
      calls.announced++;
      if (behaviour.announce) await behaviour.announce(topic, payload);
    },
  };
}

const workerNamed = (id: string, processor: any): WebhookWorker => {
  const w = new WebhookWorker(processor as any);
  // The identity the lease is written under; fixed per worker so the tests can
  // tell two of them apart.
  (w as any).me = id;
  return w;
};

const addEvent = async (over: Record<string, any> = {}) => (await one<any>(
  `INSERT INTO sd_webhook_events
     (shop_id, webhook_id, topic, status, attempts, received_at, next_attempt_at, payload)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
  [shopId, `wk-${Date.now()}-${++seq}`, over.topic ?? 'orders/updated',
   over.status ?? 'PENDING', over.attempts ?? 0,
   over.received_at ?? new Date(), over.next_attempt_at === undefined ? new Date() : over.next_attempt_at,
   JSON.stringify(over.payload ?? { id: 1001 })])).id as string;

const read = (id: string) => one<any>(
  `SELECT status, attempts, lease_owner, lease_expires_at, next_attempt_at, error, processed_at
     FROM sd_webhook_events WHERE id = $1`, [id]);

const clean = () => query(`DELETE FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);

async function main() {
  shopId = (await one<any>(`SELECT id FROM sd_shops WHERE myshopify_domain = $1`, [SHOP_DOMAIN]))?.id
    ?? (await one<any>(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ($1,'Worker fixture','EGP','Africa/Cairo') RETURNING id`, [SHOP_DOMAIN])).id;
  await clean();

  /* ------------------------------------------------- the ordinary journey -- */
  section('One event, start to finish');
  {
    const p = stub();
    const w = workerNamed('worker-a', p);
    const id = await addEvent();

    eq('the worker finds work', await w.runOnce(), true);
    const r = await read(id);
    eq('the event is processed', r.status, 'PROCESSED');
    eq('the attempt is counted', r.attempts, 1);
    check('the lease is given back', r.lease_owner === null && r.lease_expires_at === null);
    check('and it is stamped finished', !!r.processed_at);
    eq('the payload was applied once', p.calls.applied, 1);
    eq('and announced once, after completion', p.calls.announced, 1);

    eq('a second run finds nothing', await w.runOnce(), false);
    eq('and does not apply it again', p.calls.applied, 1);
  }

  section('A stale payload is recorded, not announced');
  {
    await clean();
    const p = stub({ apply: async () => false });
    const w = workerNamed('worker-a', p);
    const id = await addEvent();
    await w.runOnce();

    const r = await read(id);
    eq('the event is STALE', r.status, 'STALE');
    eq('nothing was announced', p.calls.announced, 0);
    check('and no error was recorded, because nothing failed', r.error === null);
  }

  /* ------------------------------------------------------ concurrent claims -- */
  section('Two workers racing for the same events');
  {
    await clean();
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await addEvent());

    /* Both run the claim repeatedly, at the same time. FOR UPDATE SKIP LOCKED
       is what makes this safe: the losing statement steps over a locked row
       rather than blocking on it or taking it as well. */
    const a = stub({ apply: async () => { await new Promise((r) => setTimeout(r, 5)); return true; } });
    const b = stub({ apply: async () => { await new Promise((r) => setTimeout(r, 5)); return true; } });
    const wa = workerNamed('worker-a', a);
    const wb = workerNamed('worker-b', b);

    const drain = async (w: WebhookWorker) => { while (await w.runOnce()) { /* keep going */ } };
    await Promise.all([drain(wa), drain(wb)]);

    const rows = await query<any>(
      `SELECT status, attempts FROM sd_webhook_events WHERE shop_id = $1`, [shopId]);
    eq('every event is processed', rows.filter((r) => r.status === 'PROCESSED').length, 12);
    check('each exactly once -- no event was claimed twice',
      rows.every((r) => r.attempts === 1), JSON.stringify(rows.map((r) => r.attempts)));
    eq('and the work adds up across the two workers', a.calls.applied + b.calls.applied, 12);
    check('with both workers actually taking some',
      a.calls.applied > 0 && b.calls.applied > 0, `${a.calls.applied}/${b.calls.applied}`);
  }

  section('A claimed event is invisible to another worker');
  {
    await clean();
    const id = await addEvent();

    // Hold the claim by never finishing: claim directly.
    const holder = workerNamed('worker-a', stub());
    const claimed = await (holder as any).claim();
    eq('the first worker holds it', claimed.id, id);

    const other = workerNamed('worker-b', stub());
    const second = await (other as any).claim();
    check('the second worker sees nothing to claim', second === null, JSON.stringify(second));

    const r = await read(id);
    eq('and the row names its owner', r.lease_owner, 'worker-a');
    check('with a lease in the future', new Date(r.lease_expires_at).getTime() > Date.now());
  }

  /* ----------------------------------------------------------- lease expiry -- */
  section('A lease that runs out');
  {
    await clean();
    const id = await addEvent();
    const stalled = workerNamed('worker-a', stub());
    await (stalled as any).claim();

    // The holder has gone quiet and its lease lapses.
    await query(`UPDATE sd_webhook_events SET lease_expires_at = now() - interval '1 second'
                  WHERE id = $1`, [id]);

    const sweeper = workerNamed('worker-b', stub());
    eq('the sweep reclaims it', await sweeper.sweepExpiredLeases(), 1);

    const r = await read(id);
    eq('it goes back to PENDING', r.status, 'PENDING');
    check('with the lease cleared', r.lease_owner === null && r.lease_expires_at === null);
    eq('and the abandoned attempt is counted, so a poison pill cannot loop for ever',
      r.attempts, 1);

    const p = stub();
    eq('another worker can now take it', await workerNamed('worker-b', p).runOnce(), true);
    eq('and processes it', (await read(id)).status, 'PROCESSED');
  }

  section('A worker that lost its lease cannot finalize');
  {
    /* The dangerous case: a stalled worker wakes after its lease was reclaimed
       and another worker already finished the event. Writing its own outcome
       would overwrite a terminal state and reset the attempt count. */
    await clean();
    const id = await addEvent();

    const stalled = workerNamed('worker-a', stub());
    const ev = await (stalled as any).claim();

    // Reclaimed and completed by somebody else in the meantime.
    await query(
      `UPDATE sd_webhook_events SET status='PROCESSED', processed_at=now(), attempts=1,
              lease_owner=NULL, lease_expires_at=NULL WHERE id=$1`, [id]);

    const wrote = await (stalled as any).complete(ev.id, 'FAILED', 'stale worker', null);
    check('its completion is refused', wrote === false);
    const r = await read(id);
    eq('the terminal state stands', r.status, 'PROCESSED');
    eq('and the attempt count is not reset', r.attempts, 1);
    check('no error was written over it', r.error === null);
  }

  section('A worker whose lease merely expired cannot finalize either');
  {
    await clean();
    const id = await addEvent();
    const w = workerNamed('worker-a', stub());
    const ev = await (w as any).claim();
    await query(`UPDATE sd_webhook_events SET lease_expires_at = now() - interval '1 second'
                  WHERE id = $1`, [id]);

    const wrote = await (w as any).complete(ev.id, 'PROCESSED', null, null);
    check('completion requires a live lease, not just the right owner', wrote === false);
    eq('so the event stays claimable once swept', (await read(id)).status, 'PROCESSING');
  }

  /* ------------------------------------------------------- retry and backoff -- */
  section('Transient failures back off, then give up');
  {
    await clean();
    const p = stub({ apply: async () => { throw new Error('shopify 503'); } });
    const w = workerNamed('worker-a', p);
    const id = await addEvent();

    await w.runOnce();
    let r = await read(id);
    eq('the first failure is retryable', r.status, 'FAILED');
    eq('the attempt is counted', r.attempts, 1);
    check('the error is kept', /503/.test(r.error ?? ''));
    check('and a retry is scheduled in the future',
      r.next_attempt_at !== null && new Date(r.next_attempt_at).getTime() > Date.now());

    eq('it is not picked up before then', await w.runOnce(), false);

    /* Run it to exhaustion, bringing each retry forward rather than waiting
       out eight hours of real backoff. */
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      await query(`UPDATE sd_webhook_events SET next_attempt_at = now() WHERE id = $1`, [id]);
      await w.runOnce();
      r = await read(id);
      if (i < MAX_ATTEMPTS) {
        eq(`attempt ${i} is still retryable`, r.status, 'FAILED');
      }
    }

    eq('the last attempt is terminal', r.status, 'DEAD');
    eq('with every attempt counted', r.attempts, MAX_ATTEMPTS);
    check('and no further retry scheduled', r.next_attempt_at === null);
    eq('so nothing claims it again', await w.runOnce(), false);
  }

  section('A failure part-way leaves the event retryable, not lost');
  {
    /* The crash this guards: the business write lands and the process dies
       before the status write. The event stays claimable and is applied again
       -- which is safe because every write on that path is idempotent. */
    await clean();
    let appliedCount = 0;
    const p = stub({
      apply: async () => {
        appliedCount++;
        if (appliedCount === 1) throw new Error('killed after writing');
        return true;
      },
    });
    const w = workerNamed('worker-a', p);
    const id = await addEvent();

    await w.runOnce();
    eq('the first pass failed', (await read(id)).status, 'FAILED');

    await query(`UPDATE sd_webhook_events SET next_attempt_at = now() WHERE id = $1`, [id]);
    await w.runOnce();

    const r = await read(id);
    eq('the retry succeeds', r.status, 'PROCESSED');
    eq('the payload was applied twice in total', appliedCount, 2);
    eq('and both attempts are recorded', r.attempts, 2);
  }

  /* ---------------------------------------------------------- crash recovery -- */
  section('A process that dies mid-event');
  {
    await clean();
    const id = await addEvent();

    // A worker claims, then the process disappears: the row is left PROCESSING
    // with a live lease and nobody running.
    const dying = workerNamed('worker-a', stub());
    await (dying as any).claim();
    check('the row is left in flight', (await read(id)).status, 'PROCESSING');

    /* The same worker identity starts again. It does not wait out the lease:
       there is one process with this id, it is this one, and it has just
       started, so anything it holds is certainly abandoned. */
    const restarted = workerNamed('worker-a', stub());
    await (restarted as any).reclaimOwn();

    const r = await read(id);
    eq('its own abandoned work is recovered at once', r.status, 'PENDING');
    check('the lease is cleared', r.lease_owner === null);
    eq('and the attempt is not charged against it', r.attempts, 0);
    eq('so it is picked up immediately', await restarted.runOnce(), true);
    eq('and processed', (await read(id)).status, 'PROCESSED');
  }

  section('A different host takes over abandoned work');
  {
    await clean();
    const id = await addEvent();
    await (workerNamed('worker-a', stub()) as any).claim();

    // worker-b cannot know worker-a is dead until the lease lapses.
    const b = workerNamed('worker-b', stub());
    eq('before expiry it leaves it alone', await b.sweepExpiredLeases(), 0);
    eq('and will not claim it', await b.runOnce(), false);

    await query(`UPDATE sd_webhook_events SET lease_expires_at = now() - interval '1 second'
                  WHERE id = $1`, [id]);
    eq('after expiry it reclaims it', await b.sweepExpiredLeases(), 1);
    eq('and runs it', await b.runOnce(), true);
    eq('to completion', (await read(id)).status, 'PROCESSED');
  }

  section('Repeated abandonment ends somewhere');
  {
    /* An event whose payload kills whatever picks it up would otherwise be
       reclaimed for ever, taking a worker down each time, with nothing in the
       data to show why. */
    await clean();
    const id = await addEvent({ attempts: MAX_ATTEMPTS - 1 });
    await (workerNamed('worker-a', stub()) as any).claim();
    await query(`UPDATE sd_webhook_events SET lease_expires_at = now() - interval '1 second'
                  WHERE id = $1`, [id]);

    await workerNamed('worker-b', stub()).sweepExpiredLeases();
    const r = await read(id);
    eq('the last abandonment is terminal', r.status, 'DEAD');
    check('and says why', /abandoned/.test(r.error ?? ''), String(r.error));
    check('with no retry scheduled', r.next_attempt_at === null);
  }

  /* --------------------------------------------------------- Redis is absent -- */
  section('Processing does not depend on Redis');
  {
    /* The worker never touches Redis: it finds work by querying PostgreSQL.
       Proven by pointing REDIS_URL at a closed port for the duration -- if
       anything in the path reached for it, this would hang or throw. */
    await clean();
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';   // nothing listening

    const p = stub();
    const w = workerNamed('worker-a', p);
    const id = await addEvent();

    let threw: string | null = null;
    try { await w.runOnce(); } catch (e: any) { threw = e?.message ?? String(e); }

    check('the worker does not fail', threw === null, String(threw));
    eq('and the event is processed', (await read(id)).status, 'PROCESSED');
    eq('having been applied', p.calls.applied, 1);

    if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
  }

  /* --------------------------------------------------------- what it reports -- */
  section('Backlog figures reflect the table');
  {
    await clean();
    await addEvent();
    await addEvent({ status: 'FAILED', attempts: 2, next_attempt_at: new Date(Date.now() + 3600_000) });
    await addEvent({ status: 'DEAD', attempts: MAX_ATTEMPTS, next_attempt_at: null });
    /* Set directly rather than through claim(): claim takes the OLDEST due
       event, which is the pending one above, not this one. */
    const held = await addEvent();
    await query(
      `UPDATE sd_webhook_events
          SET status = 'PROCESSING', lease_owner = 'worker-gone',
              lease_expires_at = now() - interval '1 second'
        WHERE id = $1`, [held]);

    const b = await workerNamed('worker-a', stub()).backlog();
    eq('pending', b.pending, 1);
    eq('processing', b.processing, 1);
    eq('failed', b.failed, 1);
    eq('dead', b.dead, 1);
    eq('abandoned leases are counted separately', b.abandoned, 1);
    eq('and only work that is actually due counts as due', b.due, 1);
  }

  /* ------------------------------------------------------- graceful shutdown -- */
  section('Graceful shutdown finishes what is in hand');
  {
    await clean();
    let resolveSlow: (() => void) | null = null;
    const slow = new Promise<void>((r) => { resolveSlow = r; });
    const p = stub({ apply: async () => { await slow; return true; } });
    const w = workerNamed('worker-a', p);

    const id = await addEvent();
    w.start();

    // Wait until it has the event in hand.
    for (let i = 0; i < 100 && (await read(id)).status !== 'PROCESSING'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    eq('the worker has claimed it', (await read(id)).status, 'PROCESSING');

    const stopping = w.onApplicationShutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    eq('shutdown waits rather than abandoning it', (await read(id)).status, 'PROCESSING');

    resolveSlow!();
    await stopping;

    const r = await read(id);
    eq('the event in hand is finished', r.status, 'PROCESSED');
    check('and its lease released', r.lease_owner === null);

    const after = await addEvent();
    await new Promise((r) => setTimeout(r, 60));
    eq('a stopped worker takes nothing new', (await read(after)).status, 'PENDING');
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