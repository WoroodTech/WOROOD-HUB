/**
 * Scheduled jobs across more than one instance.
 *
 *   DATABASE_URL=... npx tsx test/job-lock.test.ts
 *
 * The thing being tested is what happens when two processes do the same thing
 * at the same moment, so a mock is no use: the exclusion lives in a conditional
 * UPDATE and only a real database evaluates it.
 *
 * Two instances are simulated by passing different owner ids, which is exactly
 * what distinguishes them in production -- the rest of the process is
 * irrelevant to the lock.
 *
 * No Shopify call and no schedule is started.
 */
import { query, one, closeDb } from '../src/common/db';
import {
  acquire, release, renew, withJobLock, runDailyOnce, ranOn, dayOf, lockStatus,
} from '../src/common/job-lock';

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

const A = 'instance-a', B = 'instance-b';
const JOB = 'test:job';
const clean = () => query(`DELETE FROM core_job_locks WHERE name LIKE 'test:%'`);
const row = () => one<any>(`SELECT * FROM core_job_locks WHERE name = $1`, [JOB]);

async function main() {
  await clean();

  /* ------------------------------------------------- two instances, one job -- */
  section('Two instances, one job');
  {
    check('the first takes the lease', await acquire(JOB, 60_000, A));
    check('the second is refused', !(await acquire(JOB, 60_000, B)));
    const r = await row();
    eq('and the row names the holder', r.owner, A);
    check('with a lease in the future', new Date(r.expires_at).getTime() > Date.now());
  }

  section('Several instances arriving at once');
  {
    await clean();
    /* The case a process-local flag cannot cover: four schedulers ticking in
       the same second. Exactly one must proceed. */
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => acquire(JOB, 60_000, id)));
    eq('exactly one of four wins', results.filter(Boolean).length, 1);
  }

  section('Releasing hands it on');
  {
    await clean();
    await acquire(JOB, 60_000, A);
    check('the holder can release it', await release(JOB, true, undefined, A));
    check('and the next instance takes it', await acquire(JOB, 60_000, B));
    const r = await row();
    eq('the new holder is recorded', r.owner, B);
  }

  section('An instance that no longer holds it cannot release it');
  {
    await clean();
    await acquire(JOB, 60_000, A);
    await release(JOB, true, undefined, A);
    await acquire(JOB, 60_000, B);

    /* A straggler finishing late must not write its own outcome over the run
       that is currently going. */
    check('a release from the instance that no longer holds it is refused',
      !(await release(JOB, true, undefined, A)));
    const r = await row();
    eq('the current holder still holds it', r.owner, B);
    check('and its lease is untouched', new Date(r.expires_at).getTime() > Date.now());
  }

  /* --------------------------------------------------------- crash recovery -- */
  section('A crashed instance does not hold it for ever');
  {
    await clean();
    await acquire(JOB, 60_000, A);
    check('while the lease is live, nobody else may take it',
      !(await acquire(JOB, 60_000, B)));

    // The holder died: nothing released it, the lease simply runs out.
    await query(`UPDATE core_job_locks SET expires_at = now() - interval '1 second'
                  WHERE name = $1`, [JOB]);

    check('once it lapses, another instance takes over', await acquire(JOB, 60_000, B));
    const r = await row();
    eq('and becomes the owner', r.owner, B);
  }

  section('A lease can be extended by its holder while the job runs');
  {
    await clean();
    await acquire(JOB, 2_000, A);
    const before = new Date((await row()).expires_at).getTime();
    check('the holder may renew', await renew(JOB, 60_000, A));
    const after = new Date((await row()).expires_at).getTime();
    check('which pushes the expiry out', after > before, `${before} -> ${after}`);
    check('but another instance may not renew it', !(await renew(JOB, 60_000, B)));
  }

  /* ------------------------------------------------------------ withJobLock -- */
  section('withJobLock runs the job on one instance only');
  {
    await clean();
    let ran = 0;
    const slow = async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 120));
      return 'done';
    };

    const [first, second] = await Promise.all([
      withJobLock(JOB, slow, { ttlMs: 60_000, owner: A }),
      withJobLock(JOB, slow, { ttlMs: 60_000, owner: B }),
    ]);

    eq('the job body ran once', ran, 1);
    const outcomes = [first.outcome, second.outcome].sort();
    eq('one ran, one found it held', outcomes, ['held-elsewhere', 'ran']);
    check('and the one that ran returned its value',
      first.value === 'done' || second.value === 'done');

    const r = await row();
    check('the lease is given back afterwards',
      new Date(r.expires_at).getTime() <= Date.now() + 1000, String(r.expires_at));
    check('and success is recorded', !!r.last_ok_at);
    check('with no error', r.last_error === null);
  }

  section('A job that throws releases the lease and records why');
  {
    await clean();
    let threw = false;
    try {
      await withJobLock(JOB, async () => { throw new Error('shopify 503'); },
        { ttlMs: 60_000, owner: A });
    } catch { threw = true; }

    check('the failure reaches the caller', threw);
    const r = await row();
    check('the lease is not held open until it expires',
      new Date(r.expires_at).getTime() <= Date.now() + 1000);
    check('the error is kept', /503/.test(r.last_error ?? ''), String(r.last_error));
    check('and success is NOT recorded', r.last_ok_at === null);

    /* Which matters for the next tick: a failed run must not block the retry
       for the whole lease. */
    check('so the next instance can run it immediately', await acquire(JOB, 60_000, B));
  }

  /* ------------------------------------------------------- once per Cairo day -- */
  section('Daily jobs run once a day, across instances and restarts');
  {
    await clean();
    const DAILY = 'test:daily';
    await query(`DELETE FROM core_job_locks WHERE name = $1`, [DAILY]);
    const today = dayOf(new Date());
    let ran = 0;
    const job = async () => { ran++; };

    const first = await runDailyOnce(DAILY, today, job, { owner: A });
    eq('the first instance runs it', first.outcome, 'ran');
    eq('once', ran, 1);

    const second = await runDailyOnce(DAILY, today, job, { owner: B });
    eq('a second instance finds it already done', second.outcome, 'already-done-today');
    eq('and does not run it again', ran, 1);

    /* A restart is the same question: the process has no memory, the table
       does. This is what the process-local date field could not do. */
    const afterRestart = await runDailyOnce(DAILY, today, job, { owner: 'instance-a-restarted' });
    eq('and a restarted instance does not repeat it', afterRestart.outcome, 'already-done-today');
    eq('still once', ran, 1);

    const tomorrow = dayOf(new Date(Date.now() + 36 * 3600_000));
    const next = await runDailyOnce(DAILY, tomorrow, job, { owner: A });
    eq('but the next day it runs again', next.outcome, 'ran');
    eq('twice in total', ran, 2);
  }

  section('Two instances reaching a daily job in the same instant');
  {
    await clean();
    const DAILY = 'test:daily-race';
    await query(`DELETE FROM core_job_locks WHERE name = $1`, [DAILY]);
    const today = dayOf(new Date());
    let ran = 0;
    const job = async () => { ran++; await new Promise((r) => setTimeout(r, 80)); };

    /* Both pass the "has it run today" check before either has finished. Only
       the second look, taken inside the lease, stops the loser running it a
       second time after waiting for the winner. */
    const results = await Promise.all([
      runDailyOnce(DAILY, today, job, { owner: A }),
      runDailyOnce(DAILY, today, job, { owner: B }),
      runDailyOnce(DAILY, today, job, { owner: 'instance-c' }),
    ]);

    eq('the job body ran exactly once', ran, 1);
    eq('and exactly one reports having run',
      results.filter((r) => r.outcome === 'ran').length, 1);
    check('the others did not', results.filter((r) => r.outcome !== 'ran').length === 2,
      JSON.stringify(results.map((r) => r.outcome)));
    check('and it is recorded as done today', await ranOn(DAILY, today));
  }

  section('The Cairo day is what decides, not UTC');
  {
    /* 02:00 Cairo is 00:00 UTC in winter, so a UTC date guard beside a Cairo
       hour check disagrees about which day it is at exactly the hour the
       nightly jobs run. */
    const winterNight = new Date('2026-01-15T00:30:00Z');   // 02:30 Cairo, same date
    const summerNight = new Date('2026-07-15T23:30:00Z');   // 02:30 Cairo, NEXT date
    eq('a winter night maps to its Cairo date', dayOf(winterNight), '2026-01-15');
    eq('a summer night after midnight Cairo is the following day',
      dayOf(summerNight), '2026-07-16');
    check('which UTC would have called the previous day',
      summerNight.toISOString().slice(0, 10) === '2026-07-15');
  }

  section('Unassigned escalation claims before it notifies');
  {
    /* The defect this phase exists for, and the one that reaches people.
    
       escalateUnassigned used to SELECT tickets with no ESCALATED event,
       notify every manager, then INSERT the event. Two schedulers ticking in
       the same second both saw it missing and both notified -- so the message
       saying "nobody has picked this up" arrived twice.
    
       Writing the event first inverts it: the INSERT ... WHERE NOT EXISTS is
       evaluated once under the row lock, so of two instances exactly one gets
       the row back and only it notifies. */
    /* Fixtures of its own rather than borrowing whatever happens to be in the
       database: a test that skips when the table is empty proves nothing, and
       this is the defect most worth proving. */
    const dept = await one<any>(
      `INSERT INTO core_departments (name) VALUES ($1) RETURNING id`,
      [`P7 probe ${Date.now()}`]);
    const user = await one<any>(
      `INSERT INTO core_users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Phase 7 probe') RETURNING id`,
      [`p7-${Date.now()}@example.invalid`]);

    {
      const ref = `P7-${Date.now()}`;
      const item = await one<any>(
        `INSERT INTO tk_items (reference, title, status, priority, department_id,
                               requester_id, created_at)
         VALUES ($1, 'Phase 7 escalation probe', 'NEW', 'NORMAL', $2, $3,
                 now() - interval '48 hours')
         RETURNING id`, [ref, dept.id, user.id]);

      /* The claim, run from two "instances" at once. */
      const claimOnce = () => query<any>(
        `WITH claimed AS (
           INSERT INTO tk_events (item_id, actor_id, type, payload)
           SELECT t.id, NULL, 'ESCALATED', '{}'::jsonb
             FROM tk_items t
            WHERE t.id = $1 AND t.status = 'NEW'
              AND NOT EXISTS (SELECT 1 FROM tk_events e
                               WHERE e.item_id = t.id AND e.type = 'ESCALATED')
           ON CONFLICT DO NOTHING
           RETURNING item_id
         )
         SELECT item_id FROM claimed`, [item.id]);

      const [a, b] = await Promise.all([claimOnce(), claimOnce()]);
      eq('exactly one instance claims the ticket', [a.length, b.length].sort(), [0, 1]);

      const events = await one<any>(
        `SELECT count(*) AS n FROM tk_events WHERE item_id = $1 AND type = 'ESCALATED'`,
        [item.id]);
      eq('and only one ESCALATED event exists', Number(events.n), 1);

      // A later tick must not escalate it again.
      const again = await claimOnce();
      eq('a later tick claims nothing', again.length, 0);

      await query(`DELETE FROM tk_events WHERE item_id = $1`, [item.id]);
      await query(`DELETE FROM tk_items WHERE id = $1`, [item.id]);
    }
    await query(`DELETE FROM core_users WHERE id = $1`, [user.id]);
    await query(`DELETE FROM core_departments WHERE id = $1`, [dept.id]);
  }

  section('What the locks report');
  {
    await clean();
    await acquire('test:visible', 60_000, A);
    const all = (await lockStatus()).filter((l: any) => l.name.startsWith('test:'));
    const mine = all.find((l: any) => l.name === 'test:visible');
    check('a held lock is reported as held', mine?.held === true);
    eq('with its owner', mine?.owner, A);
    check('and when it was taken', !!mine?.acquired_at);
  }

  await clean();
  await query(`DELETE FROM core_job_locks WHERE name LIKE 'test:%'`);

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });