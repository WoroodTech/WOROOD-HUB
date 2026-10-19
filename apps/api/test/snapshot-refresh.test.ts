/**
 * One snapshot refresh at a time, across processes.
 *
 *   DATABASE_URL=... npx tsx test/snapshot-refresh.test.ts
 *
 * refreshRecent makes three ShopifyQL captures -- the most expensive calls the
 * system makes, and the ones already producing throttling. It was guarded by
 * `inFlight`, a field on the service, which holds for exactly as long as there
 * is one instance of it.
 *
 * That stopped being true when the webhook worker went live. The worker
 * refreshes after processing events; the API refreshes after reconciliation and
 * on the hour. Neither can see the other's field, so the same three captures
 * ran twice over the same range, writing the same rows, out of the same cost
 * bucket.
 *
 * Two processes are simulated the way they differ in production: two service
 * instances, each with its own `inFlight`, sharing one database.
 */
import { query, closeDb } from '../src/common/db';
import { SnapshotService } from '../src/modules/sales-dashboard/analytics/snapshot.service';

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

/** A service whose three captures are counted instead of reaching Shopify. */
function snapshots(counters: { captures: number; concurrent: number; peak: number }) {
  // (shopify, shops) — the two it declares.
  const s = new SnapshotService({} as any, {} as any) as any;
  const capture = async (rows: number) => {
    counters.captures++;
    counters.concurrent++;
    counters.peak = Math.max(counters.peak, counters.concurrent);
    await new Promise((r) => setTimeout(r, 60));
    counters.concurrent--;
    return rows;
  };
  s.captureDaily = () => capture(100);
  s.captureHourly = () => capture(10);
  s.captureBreakdowns = () => capture(1);
  s.log = { log: () => undefined, warn: () => undefined, error: () => undefined };
  return s;
}

const clearLock = () => query(`DELETE FROM core_job_locks WHERE name = 'sales:snapshot-refresh'`);

async function main() {
  await clearLock();

  section('Two processes asking at the same moment');
  {
    const counters = { captures: 0, concurrent: 0, peak: 0 };
    // Two instances, as the API and the worker are.
    const api = snapshots(counters);
    const worker = snapshots(counters);

    const [a, b] = await Promise.all([api.refreshRecent(), worker.refreshRecent()]);

    eq('only one set of three captures runs', counters.captures, 3);
    eq('and never two at once', counters.peak, 1);
    check('one caller gets the row count', a === 111 || b === 111, `${a} / ${b}`);
    check('the other stands aside rather than repeating the work',
      (a === 0 || b === 0) && a !== b, `${a} / ${b}`);
  }

  section('Four callers, which is what a busy minute looks like');
  {
    await clearLock();
    const counters = { captures: 0, concurrent: 0, peak: 0 };
    const instances = [snapshots(counters), snapshots(counters),
                       snapshots(counters), snapshots(counters)];
    const results = await Promise.all(instances.map((s) => s.refreshRecent()));

    eq('still one set of captures', counters.captures, 3);
    eq('still never concurrent', counters.peak, 1);
    eq('exactly one caller did the work', results.filter((r) => r > 0).length, 1);
  }

  section('The lease is released, so the next refresh is not blocked');
  {
    await clearLock();
    const counters = { captures: 0, concurrent: 0, peak: 0 };
    const s = snapshots(counters);

    const first = await s.refreshRecent();
    eq('the first refresh runs', first, 111);

    // A later tick, after the first has finished.
    const second = await s.refreshRecent();
    eq('and so does the next one', second, 111);
    eq('six captures in total, three each', counters.captures, 6);
  }

  section('A refresh that throws gives the lease back');
  {
    await clearLock();
    const counters = { captures: 0, concurrent: 0, peak: 0 };
    const broken = snapshots(counters);
    broken.captureHourly = async () => { throw new Error('THROTTLED'); };

    let threw = false;
    try { await broken.refreshRecent(); } catch { threw = true; }
    check('the failure reaches the caller', threw);

    /* And does not wedge the lock: a refresh held until its lease expired would
       leave the figures stale for ten minutes over one throttled call. */
    const healthy = snapshots(counters);
    const after = await healthy.refreshRecent();
    eq('the next refresh runs immediately', after, 111);
  }

  section('The in-process guard still joins rather than skipping');
  {
    /* Within one process the old behaviour is better than the new one: a second
       caller gets the same promise and the same answer, instead of being told
       to go away. That must survive the cross-process lock. */
    await clearLock();
    const counters = { captures: 0, concurrent: 0, peak: 0 };
    const s = snapshots(counters);

    const [a, b] = await Promise.all([s.refreshRecent(), s.refreshRecent()]);
    eq('one set of captures', counters.captures, 3);
    eq('and both callers get the real answer, not a zero', [a, b], [111, 111]);
  }

  await clearLock();

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });