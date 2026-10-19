/**
 * Waiting out Shopify's cost bucket.
 *
 *   npx tsx test/throttle.test.ts
 *
 * The failure this pins: the hourly snapshot reported "Shopify request failed
 * after retries" while the API was perfectly healthy. Four scheduled jobs
 * started within ninety seconds of boot, all drawing on the same cost bucket;
 * the ShopifyQL capture was the most expensive and lost. Every one of its six
 * attempts was spent waiting on a throttle, and running out of waits was
 * reported as the request having failed.
 *
 * A throttle is not a failure. It is Shopify saying "not yet" about a bucket
 * that refills at a known rate. So it gets its own allowance and does not
 * consume the budget reserved for things that are actually broken.
 *
 * No network and no database: fetch is replaced, so the retry logic is driven
 * directly and the timing is the test's to control.
 */
import { LiveShopifySource } from '../src/modules/sales-dashboard/shopify/shopify.service';

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

const THROTTLED = {
  ok: true,
  json: async () => ({
    errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
  }),
};
const OK = (data: any) => ({ ok: true, json: async () => ({ data }) });

/** What the stubs count, declared up front so every field exists from the start. */
interface Counters {
  throttleMarks: number;
  success: number;
  failures: string[];
  /** Failure-curve waits: network errors, not throttles. */
  backoffs: number;
  /** The index passed to each throttle-curve wait, in order. */
  throttleWaits: number[];
  /** Every line the client logged, so the noise is a number and not a feeling. */
  logs: { level: 'log' | 'warn' | 'error' | 'debug'; msg: string }[];
}

/** A service with its collaborators replaced and its waits made instant, so a
 *  curve that takes minutes in production takes milliseconds here. */
function service() {
  const counters: Counters = {
    throttleMarks: 0, success: 0, failures: [], backoffs: 0, throttleWaits: [], logs: [],
  };

  const governor = {
    acquire: async () => undefined,
    observe: async () => undefined,
    markThrottled: async () => { counters.throttleMarks++; },
  };
  const tokens = { getToken: async () => 'tok' };
  const health = {
    recordSuccess: () => { counters.success++; },
    recordFailure: (m: string) => { counters.failures.push(m); },
  };

  // (tokens, governor, health) — the order LiveShopifySource declares.
  const svc = new LiveShopifySource(tokens as any, governor as any, health as any);

  // Waits are the point of the design, not of the test.
  (svc as any).backoff = async () => { counters.backoffs++; };
  (svc as any).throttleBackoff = async (n: number) => { counters.throttleWaits.push(n); };

  // Capture what the client says rather than printing it.
  const say = (level: Counters['logs'][number]['level']) =>
    (msg: string) => { counters.logs.push({ level, msg: String(msg) }); };
  (svc as any).log = { log: say('log'), warn: say('warn'), error: say('error'), debug: say('debug') };

  return { svc, counters };
}

async function main() {
  const realFetch = globalThis.fetch;

  /* ------------------------------------------------- it waits, then wins -- */
  section('A burst of throttling is waited out, not reported as failure');
  {
    const { svc, counters } = service();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // Ten throttles -- more than the six attempts the old budget allowed.
      return calls <= 10 ? THROTTLED : OK({ shop: { name: 'WOROOD' } });
    }) as any;

    const data = await (svc as any).graphql('{ shop { name } }');

    eq('the call ultimately succeeds', (data as any).shop.name, 'WOROOD');
    eq('after ten throttles', counters.throttleMarks, 10);
    eq('each of which waited on the throttle curve', counters.throttleWaits.length, 10);
    eq('and none of which burned a network-failure retry', counters.backoffs, 0);
    check('the wait climbs with each throttle',
      counters.throttleWaits.join(',') === '0,1,2,3,4,5,6,7,8,9',
      counters.throttleWaits.join(','));
    eq('no failure was recorded', counters.failures.length, 0);
    eq('and success was', counters.success, 1);

    /* Ten throttles used to be ten WARN lines, none saying which request or how
       it ended. One request, one line, and at INFO because it succeeded. */
    eq('the whole episode produced a single log line', counters.logs.length, 1);
    eq('at INFO, because the request succeeded', counters.logs[0]?.level, 'log');
    check('which says how many times and that it cleared',
      /10 time\(s\)/.test(counters.logs[0]?.msg ?? '') && /cleared/.test(counters.logs[0]?.msg ?? ''),
      counters.logs[0]?.msg);
    check('and nothing was logged as a warning',
      counters.logs.every((l) => l.level !== 'warn'));
  }

  section('A request that was never throttled says nothing');
  {
    const { svc, counters } = service();
    globalThis.fetch = (async () => OK({ shop: { name: 'WOROOD' } })) as any;
    await (svc as any).graphql('{ shop { name } }');
    eq('no log line at all', counters.logs.length, 0);
    eq('and no throttle was marked', counters.throttleMarks, 0);
  }

  section('The old budget would have given up here');
  {
    /* Six throttles used to exhaust the attempt loop outright. Proven by
       counting: more throttles than the old budget, still a success. */
    const { svc, counters } = service();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls <= 7 ? THROTTLED : OK({ ok: true });
    }) as any;

    await (svc as any).graphql('{ x }');
    check('seven throttles is more than the six attempts the old loop allowed',
      counters.throttleMarks === 7 && counters.success === 1,
      `${counters.throttleMarks} throttles, ${counters.success} success`);
  }

  /* -------------------------------------------------- patience is bounded -- */
  section('But it does not wait for ever');
  {
    const { svc, counters } = service();
    globalThis.fetch = (async () => THROTTLED) as any;

    let message = '';
    try { await (svc as any).graphql('{ x }'); }
    catch (e: any) { message = e.message; }

    check('a bucket that never clears eventually gives up',
      /throttled this request/.test(message), message);
    check('and says that is why, rather than blaming retries',
      !/failed after retries/.test(message), message);
    check('including how long it waited', /\(\d+s\)/.test(message), message);
    check('a request that gave up logs no success summary',
      counters.logs.every((l) => !/cleared after/.test(l.msg)));
    check('after a bounded number of waits',
      counters.throttleMarks >= 16 && counters.throttleMarks <= 18,
      String(counters.throttleMarks));
    eq('recording one failure', counters.failures.length, 1);
  }

  /* ------------------------------ genuine failures keep their own budget -- */
  section('A network failure is still treated as a failure');
  {
    const { svc, counters } = service();
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as any;

    let message = '';
    try { await (svc as any).graphql('{ x }'); }
    catch (e: any) { message = e.message; }

    check('it gives up after its own six attempts',
      /unreachable after 6 attempts/.test(message), message);
    eq('having waited on the failure curve, not the throttle one', counters.backoffs, 5);
    eq('and marked no throttles', counters.throttleMarks, 0);
  }

  section('Throttling followed by a network failure');
  {
    /* The two budgets are separate, so waiting out a busy bucket must not leave
       a genuine outage with nothing left to retry on. */
    const { svc, counters } = service();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 8) return THROTTLED;
      throw new Error('ECONNRESET');
    }) as any;

    let message = '';
    try { await (svc as any).graphql('{ x }'); }
    catch (e: any) { message = e.message; }

    eq('the throttles were waited out', counters.throttleMarks, 8);
    check('and the network failure still got its full six attempts',
      /unreachable after 6 attempts/.test(message), message);
  }

  globalThis.fetch = realFetch;

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });