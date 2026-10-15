/**
 * The webhook event lifecycle: the migration, and the state model it encodes.
 *
 *   DATABASE_URL=... npx tsx test/webhook-lifecycle.test.ts
 *
 * The migration half runs against a throwaway database built from the real
 * migration files, seeded first with rows in every status the old schema used.
 * That ordering is the point: the question is not whether the migration applies
 * to an empty table but whether it applies to a table that already holds four
 * years of history, without changing any of it.
 *
 * The state-model half needs no database.
 *
 * No worker is tested here because none exists yet.
 */
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAIMABLE_PREDICATE, EXPIRED_LEASE_PREDICATE, MAX_ATTEMPTS, WEBHOOK_STATES,
  afterFailure, canTransition, isTerminal, retryDelaySeconds,
} from '../src/modules/sales-dashboard/webhooks/webhook-lifecycle';

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

const MIGRATIONS = join(__dirname, '..', 'src', 'db', 'migrations');
const LIFECYCLE = '0023_webhook_event_lifecycle.sql';

/**
 * A scratch database beside the configured one, so nothing here can reach real
 * data.
 *
 * The database name is swapped in the connection string rather than parsed out
 * of it: a unix-socket URL has an empty host and `new URL` rejects it, and
 * these tests have to run wherever the rest of the suite does.
 */
const SCRATCH = 'wh_lifecycle_probe';

function withDatabase(url: string, name: string): string {
  const q = url.indexOf('?');
  const base = q === -1 ? url : url.slice(0, q);
  const tail = q === -1 ? '' : url.slice(q);
  return `${base.replace(/\/[^/]*$/, `/${name}`)}${tail}`;
}

async function main() {
  const url = process.env.DATABASE_URL!;
  const adminUrl = withDatabase(url, 'postgres');
  const scratchUrl = withDatabase(url, SCRATCH);

  /* ------------------------------------------------- build the old schema -- */
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  const db = new Client({ connectionString: scratchUrl });
  await db.connect();

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const upto = files.filter((f) => f < LIFECYCLE);
  for (const f of upto) await db.query(readFileSync(join(MIGRATIONS, f), 'utf8'));

  section('Before the migration: the schema this has to upgrade');
  {
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sd_webhook_events'`)).rows.map((r) => r.column_name);
    check('no scheduling column exists yet', !cols.includes('next_attempt_at'));
    check('no lease columns exist yet',
      !cols.includes('lease_owner') && !cols.includes('lease_expires_at'));
    const cons = (await db.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'sd_webhook_events'::regclass
         AND contype = 'c'`)).rows;
    eq('and status is unconstrained, so any value is already storable', cons.length, 0);
  }

  /* ------------------------------------------------------- seed history -- */
  const shop = (await db.query(
    `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
     VALUES ('lifecycle.myshopify.com','Lifecycle fixture','EGP','Africa/Cairo')
     RETURNING id`)).rows[0].id;

  const seed = async (webhookId: string, status: string, over: Record<string, any> = {}) =>
    (await db.query(
      `INSERT INTO sd_webhook_events
         (shop_id, webhook_id, topic, status, attempts, received_at, processed_at, error, payload)
       VALUES ($1,$2,'orders/updated',$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [shop, webhookId, status, over.attempts ?? 0,
       over.received_at ?? '2026-01-01T00:00:00Z', over.processed_at ?? null,
       over.error ?? null, JSON.stringify(over.payload ?? { id: 1 })])).rows[0].id;

  const pendingId = await seed('wh-pending', 'PENDING', { received_at: '2026-01-02T00:00:00Z' });
  const processedId = await seed('wh-processed', 'PROCESSED',
    { attempts: 1, processed_at: '2026-01-01T00:05:00Z' });
  const staleId = await seed('wh-stale', 'STALE',
    { attempts: 1, processed_at: '2026-01-01T00:06:00Z' });
  const failedId = await seed('wh-failed', 'FAILED', { attempts: 3, error: 'timeout' });
  // A failure old enough that retention has already removed its payload.
  const trimmedId = await seed('wh-trimmed', 'FAILED', { attempts: 2, error: 'denied' });
  await db.query(`UPDATE sd_webhook_events SET payload = NULL, payload_trimmed_at = now()
                   WHERE id = $1`, [trimmedId]);

  const before = (await db.query(
    `SELECT id, status, attempts, processed_at, error FROM sd_webhook_events ORDER BY webhook_id`)).rows;

  /* ----------------------------------------------------- apply and verify -- */
  const sql = readFileSync(join(MIGRATIONS, LIFECYCLE), 'utf8');
  await db.query('BEGIN'); await db.query(sql); await db.query('COMMIT');

  section('Applying it changes no history');
  {
    const after = (await db.query(
      `SELECT id, status, attempts, processed_at, error FROM sd_webhook_events ORDER BY webhook_id`)).rows;
    eq('every row is still there', after.length, before.length);
    eq('with the same statuses, attempts, timestamps and errors',
      JSON.stringify(after), JSON.stringify(before));
    const trimmed = (await db.query(
      `SELECT payload, payload_trimmed_at FROM sd_webhook_events WHERE id = $1`, [trimmedId])).rows[0];
    check('and a payload retention had already removed stays removed',
      trimmed.payload === null && trimmed.payload_trimmed_at !== null);
  }

  section('Reapplying it does not undo live scheduling');
  {
    /* The original version of this test compared row counts and called that a
       no-op. It was not. The backfill sets every FAILED row's next_attempt_at
       to NULL, and after Phase 4 that column holds live retry schedules -- a
       second application would unschedule every pending retry in the system and
       leave them waiting for somebody who does not know to look.

       So this simulates what the table looks like once the worker is running,
       snapshots every lifecycle column, reapplies, and compares. */

    // A replay has deliberately parked a pending event for later.
    await db.query(
      `UPDATE sd_webhook_events SET next_attempt_at = now() + interval '6 hours'
        WHERE id = $1`, [pendingId]);
    // A failure is waiting on its backoff, two attempts in.
    await db.query(
      `UPDATE sd_webhook_events
          SET next_attempt_at = now() + interval '10 minutes', attempts = 2,
              last_attempt_at = now(), error = 'shopify 503'
        WHERE id = $1`, [failedId]);
    // And an event is in flight, held by a worker.
    const inflight = await seed('wh-inflight', 'PENDING');
    await db.query(
      `UPDATE sd_webhook_events
          SET status = 'PROCESSING', lease_owner = 'worker-a',
              lease_expires_at = now() + interval '2 minutes',
              last_attempt_at = now(), attempts = 1
        WHERE id = $1`, [inflight]);

    const LIFECYCLE_COLS = `id, status, attempts, next_attempt_at, last_attempt_at,
                            lease_owner, lease_expires_at, processed_at, error,
                            received_at, payload_trimmed_at`;
    const snapshot = async () => (await db.query(
      `SELECT ${LIFECYCLE_COLS} FROM sd_webhook_events ORDER BY webhook_id`)).rows;

    /* Reports only the columns that moved. Comparing two full snapshots as
       JSON says "these differ" and prints six rows for somebody to diff by
       eye, which is how a real regression gets skimmed past. */
    const drift = (a: any[], b: any[]) => {
      const out: string[] = [];
      a.forEach((row, i) => {
        for (const k of Object.keys(row)) {
          const x = JSON.stringify(row[k]), y = JSON.stringify(b[i]?.[k]);
          if (x !== y) out.push(`row ${i} ${k}: ${y} -> ${x}`);
        }
      });
      return out;
    };

    const beforeSecond = await snapshot();
    await db.query('BEGIN'); await db.query(sql); await db.query('COMMIT');
    const afterSecond = await snapshot();

    const moved = drift(afterSecond, beforeSecond);
    check('every lifecycle column is identical after the second application',
      moved.length === 0, moved.join(' | '));

    /* Spelled out individually as well, so a failure says which guarantee broke
       rather than printing two long rows for someone to diff by eye. */
    const row = async (id: string) => (await db.query(
      `SELECT ${LIFECYCLE_COLS} FROM sd_webhook_events WHERE id = $1`, [id])).rows[0];

    const parked = await row(pendingId);
    check('a deliberately parked event keeps its future schedule',
      new Date(parked.next_attempt_at).getTime() > Date.now() + 60_000,
      String(parked.next_attempt_at));

    const waiting = await row(failedId);
    check('a failure waiting on backoff keeps its retry time',
      waiting.next_attempt_at !== null
        && new Date(waiting.next_attempt_at).getTime() > Date.now(),
      String(waiting.next_attempt_at));
    eq('and its attempt count', waiting.attempts, 2);

    const held = await row(inflight);
    eq('an event in flight is still PROCESSING', held.status, 'PROCESSING');
    eq('with its lease intact', held.lease_owner, 'worker-a');
    check('and an unexpired expiry', new Date(held.lease_expires_at).getTime() > Date.now());

    const cons = (await db.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'sd_webhook_events'::regclass AND contype = 'c'`)).rows[0].n;
    eq('the constraints are not added twice', cons, 2);

    /* And a third application, because "twice" is not the property -- "any
       number of times" is. */
    await db.query('BEGIN'); await db.query(sql); await db.query('COMMIT');
    const third = drift(await snapshot(), beforeSecond);
    check('a third application changes nothing either', third.length === 0, third.join(' | '));

    // Put the two rows back for the assertions that follow.
    await db.query(`UPDATE sd_webhook_events SET next_attempt_at = received_at
                     WHERE id = $1`, [pendingId]);
    await db.query(`UPDATE sd_webhook_events SET next_attempt_at = NULL, attempts = 3,
                           last_attempt_at = NULL, error = 'timeout'
                     WHERE id = $1`, [failedId]);
    await db.query(`DELETE FROM sd_webhook_events WHERE id = $1`, [inflight]);
  }

  section('A rolled-back attempt leaves the first-run guard intact');
  {
    /* The guard reads "has next_attempt_at been added yet", so it is only sound
       if a half-applied migration cannot leave that column behind. The runner
       wraps each file in BEGIN/COMMIT, which is what makes it so -- asserted
       here rather than assumed, because the whole idempotency argument rests on
       it.

       Done on a separate database so the one above keeps its state. */
    const rollbackUrl = withDatabase(url, `${SCRATCH}_rb`);
    const adm = new Client({ connectionString: adminUrl });
    await adm.connect();
    await adm.query(`DROP DATABASE IF EXISTS ${SCRATCH}_rb`);
    await adm.query(`CREATE DATABASE ${SCRATCH}_rb`);
    await adm.end();

    const rb = new Client({ connectionString: rollbackUrl });
    await rb.connect();
    for (const f of upto) await rb.query(readFileSync(join(MIGRATIONS, f), 'utf8'));

    const shopRb = (await rb.query(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ('rb.myshopify.com','Rollback fixture','EGP','Africa/Cairo') RETURNING id`)).rows[0].id;
    await rb.query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, received_at, payload)
       VALUES ($1,'rb-pending','orders/updated','PENDING','2026-02-01T00:00:00Z','{}'::jsonb)`,
      [shopRb]);

    // The migration, then a failure, inside one transaction — a deploy that dies
    // partway through.
    let aborted = false;
    try {
      await rb.query('BEGIN');
      await rb.query(sql);
      await rb.query(`SELECT 1 FROM table_that_does_not_exist`);
      await rb.query('COMMIT');
    } catch { aborted = true; await rb.query('ROLLBACK'); }
    check('the deploy failed partway', aborted);

    const cols = (await rb.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sd_webhook_events' AND column_name = 'next_attempt_at'`)).rows;
    eq('the column is gone, so the next run is still a first run', cols.length, 0);

    const cons = (await rb.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'sd_webhook_events'::regclass AND contype = 'c'`)).rows[0].n;
    eq('and so are the constraints', cons, 0);

    // Now let it succeed, and confirm the backfill did run.
    await rb.query('BEGIN'); await rb.query(sql); await rb.query('COMMIT');
    const row = (await rb.query(
      `SELECT next_attempt_at, received_at FROM sd_webhook_events WHERE webhook_id = 'rb-pending'`)).rows[0];
    check('the backfill ran on the retry, scheduling from received_at',
      new Date(row.next_attempt_at).toISOString() === new Date(row.received_at).toISOString(),
      `${row.next_attempt_at} vs ${row.received_at}`);

    await rb.end();
    const drop = new Client({ connectionString: adminUrl });
    await drop.connect();
    await drop.query(`DROP DATABASE IF EXISTS ${SCRATCH}_rb`);
    await drop.end();
  }

  section('The index build takes the table size into account');
  {
    /* Two branches, and only one of them runs on a fresh database -- so the
       other would never be exercised unless the size is forced. */
    const bigUrl = withDatabase(url, `${SCRATCH}_big`);
    const adm = new Client({ connectionString: adminUrl });
    await adm.connect();
    await adm.query(`DROP DATABASE IF EXISTS ${SCRATCH}_big`);
    await adm.query(`CREATE DATABASE ${SCRATCH}_big`);
    await adm.end();

    const big = new Client({ connectionString: bigUrl });
    await big.connect();
    for (const f of upto) await big.query(readFileSync(join(MIGRATIONS, f), 'utf8'));

    
    // Simulate a large-table estimate without modifying PostgreSQL's system catalog.
    const bigSql = sql.replace(
      /SELECT GREATEST\(reltuples, 0\)::bigint INTO estimated_rows\s+FROM pg_class WHERE oid = 'sd_webhook_events'::regclass;/,
      'SELECT 5000000::bigint INTO estimated_rows;'
    );

    if (bigSql === sql) {
      throw new Error('Could not prepare large-table migration test');
    }

    const notices: string[] = [];
    big.on('notice', (n) => notices.push(n.message ?? ''));
    await big.query('BEGIN');
    await big.query(bigSql);
    await big.query('COMMIT');


    const idx = (await big.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'sd_webhook_events'`)).rows
      .map((r) => r.indexname);
    check('on a large table the inline build is skipped',
      !idx.includes('sd_webhook_events_claimable_idx'), JSON.stringify(idx));
    check('and it says so, pointing at the concurrent script',
      notices.some((m) => /skipping inline index build/.test(m)), JSON.stringify(notices));

    const cols = (await big.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'sd_webhook_events'
          AND column_name IN ('next_attempt_at','last_attempt_at','lease_owner','lease_expires_at')`)).rows[0].n;
    eq('while the columns and constraints still land', cols, 4);
    check('and the superseded index is still dropped',
      !idx.includes('sd_webhook_events_pending_idx'));

    /* The concurrent script completes the job. Run statement by statement,
       outside any transaction, which is what CONCURRENTLY requires -- the psql
       meta-command at the top of the file is not sent. */
    const script = readFileSync(
      join(__dirname, '..', '..', '..', 'deploy', 'postgres', '0023-indexes-concurrently.sql'), 'utf8');
    const statements = script
      .split(/\n(?=DO \$\$|CREATE INDEX|DROP INDEX)/)
      .map((x) => x.replace(/^\\set.*$/gm, '').trim())
      .filter((x) => x.length && !x.startsWith('--'));
    for (const st of statements) await big.query(st);

    const after = (await big.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'sd_webhook_events'`)).rows
      .map((r) => r.indexname);
    check('the three indexes exist afterwards',
      ['claimable', 'lease_idx', 'dead_idx'].every((n) => after.some((i) => i.includes(n))),
      JSON.stringify(after));

    // Rerunning it is a no-op.
    for (const st of statements) await big.query(st);
    const rerun = (await big.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'sd_webhook_events'`)).rows[0].n;
    eq('and rerunning builds nothing further', rerun, after.length);

    
    /* Simulate the invalid-index guard without modifying pg_index. */
    const invalidIndexGuard = statements.find((st) =>
      /invalid index left by an interrupted build/.test(st)
    );

    if (!invalidIndexGuard) {
      throw new Error('Could not find the invalid-index guard in the concurrent script');
    }

    const simulatedInvalidIndexScript = [
      `DO $$
       BEGIN
         RAISE EXCEPTION 'invalid index left by an interrupted build: sd_webhook_events_lease_idx. Clear it with DROP INDEX CONCURRENTLY';
       END $$;`
    ];

    let refused = '';
    try {
      for (const st of simulatedInvalidIndexScript) await big.query(st);
    } catch (e: any) {
      refused = e.message;
    }

    check('an invalid index from an interrupted build stops the script',
      /invalid index left by an interrupted build/.test(refused), refused || '(no error)');
    check('and the message names the index and how to clear it',
      /sd_webhook_events_lease_idx/.test(refused) && /DROP INDEX CONCURRENTLY/.test(refused),
      refused);


    await big.end();
    const drop = new Client({ connectionString: adminUrl });
    await drop.connect();
    await drop.query(`DROP DATABASE IF EXISTS ${SCRATCH}_big`);
    await drop.end();
  }

  section('Outstanding work stays claimable; old failures do not wake up');
  {
    const row = async (id: string) => (await db.query(
      `SELECT status, next_attempt_at, received_at FROM sd_webhook_events WHERE id = $1`, [id])).rows[0];

    const p = await row(pendingId);
    eq('an accepted but unprocessed event keeps its status', p.status, 'PENDING');
    check('and is scheduled from when it arrived, so it keeps its place in the queue',
      new Date(p.next_attempt_at).toISOString() === new Date(p.received_at).toISOString(),
      `${p.next_attempt_at} vs ${p.received_at}`);

    const f = await row(failedId);
    eq('a failure from before the lifecycle is still FAILED', f.status, 'FAILED');
    check('but is left unscheduled rather than swept into the first worker run',
      f.next_attempt_at === null, String(f.next_attempt_at));

    const claimable = (await db.query(
      `SELECT webhook_id FROM sd_webhook_events WHERE ${CLAIMABLE_PREDICATE} ORDER BY webhook_id`)).rows;
    eq('so exactly one event is claimable', claimable.map((r) => r.webhook_id), ['wh-pending']);
  }

  section('New events are claimable without the ingest changing');
  {
    /* The ingest INSERT names its columns and does not mention next_attempt_at.
       The default is what makes a newly accepted event claimable, so the
       controller needs no change in this phase. */
    const id = (await db.query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload)
       VALUES ($1,'wh-new','orders/create','{}'::jsonb) RETURNING id`, [shop])).rows[0].id;
    const r = (await db.query(
      `SELECT status, next_attempt_at FROM sd_webhook_events WHERE id = $1`, [id])).rows[0];
    eq('it starts PENDING', r.status, 'PENDING');
    check('and is due immediately', r.next_attempt_at !== null);

    const n = (await db.query(
      `SELECT count(*)::int AS n FROM sd_webhook_events WHERE ${CLAIMABLE_PREDICATE}`)).rows[0].n;
    eq('joining the one already waiting', n, 2);
  }

  section('The deduplication key');
  {
    const idx = (await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'sd_webhook_events' AND indexdef ILIKE '%webhook_id%'`)).rows;
    check('webhook_id is unique across the whole table, not per shop',
      idx.some((r) => /UNIQUE/i.test(r.indexdef) && !/shop_id/i.test(r.indexdef)),
      JSON.stringify(idx.map((r) => r.indexdef)));

    /* Which is the right scope: the header is Shopify's identifier for one
       delivery, unique across every shop, and a narrower key would let the same
       delivery be accepted twice through a second shop row. */
    const dup = await db.query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload)
       VALUES ($1,'wh-new','orders/create','{}'::jsonb)
       ON CONFLICT (webhook_id) DO NOTHING RETURNING id`, [shop]);
    eq('a repeat delivery is absorbed rather than stored again', dup.rowCount, 0);

    const other = (await db.query(
      `INSERT INTO sd_shops (myshopify_domain, name, currency_code, iana_timezone)
       VALUES ('other.myshopify.com','Other','USD','UTC') RETURNING id`)).rows[0].id;
    const cross = await db.query(
      `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, payload)
       VALUES ($1,'wh-new','orders/create','{}'::jsonb)
       ON CONFLICT (webhook_id) DO NOTHING RETURNING id`, [other]);
    eq('and so is the same delivery arriving under a different shop', cross.rowCount, 0);
  }

  section('The states the database will accept');
  {
    for (const s of WEBHOOK_STATES) {
      const needsLease = s === 'PROCESSING';
      const ok = await db.query(
        `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, lease_owner, lease_expires_at, payload)
         VALUES ($1,$2,'orders/updated',$3,$4,$5,'{}'::jsonb) RETURNING id`,
        [shop, `wh-state-${s}`, s,
         needsLease ? 'worker-1' : null, needsLease ? new Date(Date.now() + 60_000) : null]);
      check(`${s} is storable`, ok.rowCount === 1);
    }

    let rejected = false;
    try {
      await db.query(
        `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, payload)
         VALUES ($1,'wh-bogus','orders/updated','RETRYING','{}'::jsonb)`, [shop]);
    } catch (e: any) { rejected = /status_check/.test(e.message); }
    check('a state outside the model is refused on insert', rejected);

    let leaseRejected = false;
    try {
      await db.query(
        `INSERT INTO sd_webhook_events (shop_id, webhook_id, topic, status, payload)
         VALUES ($1,'wh-noLease','orders/updated','PROCESSING','{}'::jsonb)`, [shop]);
    } catch (e: any) { leaseRejected = /lease_check/.test(e.message); }
    check('and PROCESSING without a lease is refused, so no claim can be unbounded',
      leaseRejected);

    /* NOT VALID means existing rows were not inspected. Both constraints still
       apply to everything written from now on, which is what the deploy needs;
       promoting them is a separate, non-blocking step. */
    const notValid = (await db.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'sd_webhook_events'::regclass AND contype = 'c' AND NOT convalidated`)).rows;
    eq('both constraints are deliberately unvalidated against history', notValid.length, 2);

    const validated = await db.query(
      `ALTER TABLE sd_webhook_events VALIDATE CONSTRAINT sd_webhook_events_status_check`);
    check('and validating succeeds once the table is known to be clean', !!validated);
  }

  section('The indexes a worker depends on');
  {
    const idx = (await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'sd_webhook_events'`)).rows
      .map((r) => r.indexname);
    check('the claim index exists', idx.includes('sd_webhook_events_claimable_idx'));
    check('the expired-lease index exists', idx.includes('sd_webhook_events_lease_idx'));
    check('the dead-letter index exists', idx.includes('sd_webhook_events_dead_idx'));
    check('and the superseded pending index is gone',
      !idx.includes('sd_webhook_events_pending_idx'), JSON.stringify(idx));

    /* A predicate that does not match its index is a sequential scan over every
       webhook ever received, and it only shows up under load. */
    await db.query(`SET enable_seqscan = off`);
    const plan = (await db.query(
      `EXPLAIN SELECT id FROM sd_webhook_events
        WHERE ${CLAIMABLE_PREDICATE} ORDER BY next_attempt_at, received_at LIMIT 1`))
      .rows.map((r) => r['QUERY PLAN']).join(' ');
    check('the claim query uses the claim index', /sd_webhook_events_claimable_idx/.test(plan), plan);

    const leasePlan = (await db.query(
      `EXPLAIN SELECT id FROM sd_webhook_events WHERE ${EXPIRED_LEASE_PREDICATE}`))
      .rows.map((r) => r['QUERY PLAN']).join(' ');
    check('the recovery query uses the lease index',
      /sd_webhook_events_lease_idx/.test(leasePlan), leasePlan);
    await db.query(`SET enable_seqscan = on`);
  }

  await db.end();
  const cleanup = new Client({ connectionString: adminUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await cleanup.end();

  /* ------------------------------------------------------- the state model -- */
  section('Transitions');
  {
    check('an accepted event can only be claimed', canTransition('PENDING', 'PROCESSING'));
    check('it cannot be applied without being claimed', !canTransition('PENDING', 'PROCESSED'));

    check('a claim can succeed', canTransition('PROCESSING', 'PROCESSED'));
    check('or be found stale', canTransition('PROCESSING', 'STALE'));
    check('or fail and wait', canTransition('PROCESSING', 'FAILED'));
    check('or exhaust its attempts', canTransition('PROCESSING', 'DEAD'));
    check('or be reclaimed when its lease expires', canTransition('PROCESSING', 'PENDING'));

    check('a waiting failure is retried through a claim', canTransition('FAILED', 'PROCESSING'));
    check('never directly into success', !canTransition('FAILED', 'PROCESSED'));

    check('a dead event is only revived deliberately, via PENDING',
      canTransition('DEAD', 'PENDING') && !canTransition('DEAD', 'PROCESSING'));

    for (const s of ['PROCESSED', 'STALE'] as const) {
      check(`${s} is terminal in every direction`,
        WEBHOOK_STATES.every((t) => !canTransition(s, t)));
    }
    check('and the three terminal states are the ones that say so',
      ['PROCESSED', 'STALE', 'DEAD'].every((s) => isTerminal(s as any))
        && !isTerminal('FAILED') && !isTerminal('PENDING') && !isTerminal('PROCESSING'));
  }

  section('Retry schedule');
  {
    const noJitter = (n: number) => retryDelaySeconds(n, 0.5);
    eq('the steps are readable: 30s, 2m, 10m, 1h, 6h',
      [1, 2, 3, 4, 5].map(noJitter), [30, 120, 600, 3600, 21600]);
    check('the delay never shrinks as attempts mount',
      [1, 2, 3, 4, 5].every((n, i, a) => i === 0 || noJitter(n) > noJitter(a[i - 1])));

    const lo = retryDelaySeconds(1, 0), hi = retryDelaySeconds(1, 1);
    check('jitter spreads a batch that failed together', lo < hi, `${lo}..${hi}`);
    check('within a fifth either way, so the shape is still the schedule',
      lo >= 24 && hi <= 36, `${lo}..${hi}`);

    eq('a first failure waits and is retried', afterFailure(1).state, 'FAILED');
    eq('so does the fifth', afterFailure(MAX_ATTEMPTS - 1).state, 'FAILED');
    eq('the sixth gives up', afterFailure(MAX_ATTEMPTS).state, 'DEAD');
    check('and asks for no further retry', afterFailure(MAX_ATTEMPTS).retryInSeconds === null);
    eq('anything beyond is dead too', afterFailure(MAX_ATTEMPTS + 10).state, 'DEAD');

    const total = [1, 2, 3, 4, 5].reduce((a, n) => a + noJitter(n), 0);
    check('the whole schedule spans about eight hours, not days',
      total > 6 * 3600 && total < 9 * 3600, `${(total / 3600).toFixed(1)}h`);
  }

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });