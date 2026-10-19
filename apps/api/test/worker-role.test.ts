/**
 * The webhook worker must not run the schedulers.
 *
 *   npx tsx test/worker-role.test.ts
 *
 * The worker boots the whole application module so that an event is applied by
 * the same code either way, and that boots every scheduler in it too. The
 * Sales scheduler is gated by SHOPIFY_SCHEDULE_ENABLED, which defaults to ON and
 * which the worker unit inherits from the same environment file as the API; the
 * tasks scheduler has no gate at all. Enabling the worker would therefore have
 * started a second scheduler -- harmless for the jobs behind a distributed lock,
 * and a doubled load for the ones deliberately left without one, such as the
 * abandoned-checkout sync, on a system already being throttled by Shopify.
 *
 * No database and no network: only whether timers get registered.
 */
import { SalesScheduler } from '../src/modules/sales-dashboard/sync/scheduler.service';
import { TasksScheduler } from '../src/modules/tasks/scheduler.service';
import { isWorkerProcess, declareWorkerProcess } from '../src/common/process-role';

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

const timersOf = (s: any): number => s.timers.length;

function sales() {
  const live = { source: { kind: 'live' } };
  return new SalesScheduler(
    {} as any, {} as any, live as any, {} as any, {} as any, {} as any) as any;
}
const tasks = () => new TasksScheduler({} as any, {} as any) as any;

const logged: string[] = [];
const capture = (s: any) => { s.log = { log: (m: string) => logged.push(m), warn: () => undefined, error: () => undefined }; };

async function main() {
  const saved = { role: process.env.PROCESS_ROLE };
  delete process.env.PROCESS_ROLE;

  section('The API process schedules, as it always has');
  {
    check('it is not the worker', isWorkerProcess() === false);

    const t = tasks();
    t.onModuleInit();
    check('the tasks scheduler registers its two jobs', timersOf(t) === 2, String(timersOf(t)));
    t.onModuleDestroy();

    const s = sales();
    capture(s);
    s.onModuleInit();
    check('and the sales scheduler registers its jobs', timersOf(s) > 0, String(timersOf(s)));
    s.onModuleDestroy();
  }

  section('The worker process does not');
  {
    declareWorkerProcess();
    check('it declares itself', isWorkerProcess() === true);

    const t = tasks();
    t.onModuleInit();
    eq('the tasks scheduler registers nothing', timersOf(t), 0);

    logged.length = 0;
    const s = sales();
    capture(s);
    s.onModuleInit();
    eq('and neither does the sales scheduler', timersOf(s), 0);
    check('which says why, rather than going quiet',
      logged.some((m) => /webhook worker/.test(m) && /API owns the schedule/.test(m)),
      logged.join(' | '));
  }

  section('It holds whatever SHOPIFY_SCHEDULE_ENABLED says');
  {
    /* The worker unit reads the same environment file as the API, so a flag set
       there for the API reaches the worker. The role must win, or the answer
       depends on a file the worker does not own. */
    const before = process.env.SHOPIFY_SCHEDULE_ENABLED;
    process.env.SHOPIFY_SCHEDULE_ENABLED = 'true';
    declareWorkerProcess();

    const s = sales();
    capture(s);
    s.onModuleInit();
    eq('explicitly enabled, the worker still does not schedule', timersOf(s), 0);

    if (before === undefined) delete process.env.SHOPIFY_SCHEDULE_ENABLED;
    else process.env.SHOPIFY_SCHEDULE_ENABLED = before;
  }

  section('The role is read when a scheduler starts, not when it is imported');
  {
    /* Which is what lets the worker declare itself inside main(), before the
       application context exists, without depending on the order its imports
       happen to be evaluated in. */
    delete process.env.PROCESS_ROLE;
    const s = sales();
    capture(s);
    declareWorkerProcess();           // declared AFTER the scheduler was constructed
    s.onModuleInit();
    eq('a role declared after construction still applies', timersOf(s), 0);
  }

  if (saved.role === undefined) delete process.env.PROCESS_ROLE;
  else process.env.PROCESS_ROLE = saved.role;

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });