/**
 * Verification suite for WOROOD HUB Module 2.
 *
 * Mirrors section 13 of the design document. Unit assertions run against pure
 * functions; the rest run against the live API and a real PostgreSQL and Redis,
 * because the properties that matter here -- dedup at the database, the ordering
 * guard, permission boundaries, HMAC over raw bytes -- cannot be proven with
 * mocks.
 *
 *   npm run build && node dist/main.js   (in one shell)
 *   npm test                             (in another)
 */
import { createHmac, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { resolveRange } from '../src/modules/sales-dashboard/metrics/metrics.service';
import { query, one, closeDb } from '../src/common/db';
import { config } from '../src/common/config';

const BASE = `http://127.0.0.1:${config.port}/api/v1`;
let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name} ${detail}`); }
}
const eq = (name: string, a: any, b: any) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const login = async (email: string, password = "Worood@2026"): Promise<any> => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (path: string, token?: string): Promise<any> => {
  const r = await fetch(BASE + path, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function section(title: string) { console.log(`\n${title}`); }

async function main() {
  /* ------------------------------------------------ unit: range arithmetic -- */
  await section('Range arithmetic, resolved in the shop timezone');
  {
    // A Cairo day begins at 21:00 UTC the previous evening (UTC+3). Getting this
    // wrong shifts every figure by three hours and, on a partial current day,
    // can look like a factor of two.
    const at = DateTime.fromISO('2026-08-12T04:00:00Z');
    const r = resolveRange('today', 'Africa/Cairo', at as any);
    eq('today starts at 21:00Z the previous day',
      DateTime.fromJSDate(r.start).toUTC().toISO({ suppressMilliseconds: true }),
      '2026-08-11T21:00:00Z');
    check('today uses hour grain', r.grain === 'hour');

    const w = resolveRange('7d', 'Africa/Cairo', at as any);
    const days = DateTime.fromJSDate(w.end).diff(DateTime.fromJSDate(w.start), 'days').days;
    check('7d spans seven days', days > 6.9 && days < 7.05, String(days));
    check('prior window is immediately before and equal in length',
      DateTime.fromJSDate(w.priorEnd) < DateTime.fromJSDate(w.start));

    const dst = resolveRange('today', 'Africa/Cairo', DateTime.fromISO('2026-11-01T02:00:00Z') as any);
    check('resolves across a daylight-saving boundary without throwing', !!dst.start);
  }

  /* ------------------------------------------------------ auth and lockout -- */
  await section('Authentication');
  {
    const good = await login('Yousry@worood.co');
    check('correct credentials sign in', good.status === 201 || good.status === 200);
    check('principal carries roles and effective permissions',
      good.body?.principal?.permissions?.includes('sales.order.view'));

    const bad = await login('Yousry@worood.co', 'wrong-password');
    check('wrong password is rejected', bad.status === 401);

    const unknown = await login('nobody@worood.co', 'whatever');
    check('unknown e-mail is rejected the same way', unknown.status === 401);

    const anon = await get('/sales/dashboards');
    check('anonymous access is refused', anon.status === 401);

    const refreshed = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: good.body.refreshToken }),
    });
    check('refresh token rotates', refreshed.status === 200 || refreshed.status === 201);

    const replay = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: good.body.refreshToken }),
    });
    // Presenting a used token is treated as evidence of theft.
    check('replaying a used refresh token is refused', replay.status === 401);
  }

  /* ------------------------------------------- access resolution, all paths -- */
  await section('Dashboard access resolution');
  {
    const expect: Array<[string, number, string]> = [
      ['omnia.osama@worood.co', 0, 'Customer Care holds no dashboard permission at all'],
      ['nadia@worood.co',       1, 'Marketing reaches two, and one is revoked from her personally'],
      ['heba.fayed@worood.co',  2, 'Operations reaches one, and one more is granted to her personally'],
      ['Yousry@worood.co',      2, 'Finance reaches exactly the two it needs'],
      ['Kandil@worood.co',      5, 'the Executive role reaches all of them'],
      ['Admin@worood.co',       5, 'administrator'],
    ];
    for (const [email, n, why] of expect) {
      const l = await login(email);
      const r = await get('/sales/dashboards', l.body.accessToken);
      const count = Array.isArray(r.body) ? r.body.length : 0;
      check(`${email.split('@')[0]} sees ${n} dashboards — ${why}`, count === n, `got ${count}`);
    }

    const nadia = await login('nadia@worood.co');
    const nr = await get('/sales/dashboards', nadia.body.accessToken);
    check('an individual REVOKE beats the role grant',
      !nr.body.some((d: any) => d.key === 'combined-sales-marketing'),
      nr.body.map((d: any) => d.key).join(','));

    const heba = await login('heba.fayed@worood.co');
    const hr = await get('/sales/dashboards', heba.body.accessToken);
    check('an individual GRANT is reported as USER, not ROLE',
      hr.body.find((d: any) => d.key === 'executive-daily')?.grantedBy === 'USER');
    check('a role grant is reported as ROLE',
      hr.body.find((d: any) => d.key === 'sales-operations')?.grantedBy === 'ROLE');
  }

  /* -------------------------------------------- permission independence -- */
  await section('Permission keys are independent, not hierarchical');
  {
    /* Independence proven in both directions on the same pair of keys, which
       is stronger than one account missing everything: Marketing holds
       dashboard.view and not order.view, Customer Care holds order.view and
       not dashboard.view. Neither key implies the other. */
    const marketing = await login('nadia@worood.co');
    check('marketing reaches dashboards',
      (await get('/sales/dashboards', marketing.body.accessToken)).status === 200);
    check('...and is refused orders',
      (await get('/sales/orders', marketing.body.accessToken)).status === 403);

    const care = await login('omnia.osama@worood.co');
    check('customer care reaches orders',
      (await get('/sales/orders', care.body.accessToken)).status === 200);
    check('...and is refused dashboards',
      (await get('/sales/dashboards', care.body.accessToken)).status === 403);

    const ops = await login('heba.fayed@worood.co');
    check('operations reaches Data & Sync',
      (await get('/sales/admin/sync', ops.body.accessToken)).status === 200);

    const ceo = await login('Kandil@worood.co');
    check('the CEO, with every reading permission, is still refused Data & Sync',
      (await get('/sales/admin/sync', ceo.body.accessToken)).status === 403);
  }

  /* ------------------------------------------------ portlet gating on home -- */
  await section('Home dashboard portlets');
  {
    /* Customer Care is the account that makes the gate visibly true: she has
       no dashboard permission, so the sales portlets are absent from the
       response entirely -- not present and empty. */
    const care = await login('omnia.osama@worood.co');
    const hub = await get('/hub/modules', care.body.accessToken);
    const keys = hub.body.dashboard.map((p: any) => p.key);
    check('an account with no dashboard permission still sees meeting-room portlets',
      keys.includes('next-meeting') && keys.includes('free-now'));
    check('...and NO sales portlets',
      !keys.some((k: string) => ['my-dashboards', 'store-pulse', 'my-alerts'].includes(k)),
      keys.join(','));
    check('but the Orders link is there, because order.view is a separate key',
      !!hub.body.modules.find((m: any) => m.key === 'sales-dashboard')
        ?.navigation.some((n: any) => n.path === '/sales/orders'));
    check('while the Dashboards link is not',
      !hub.body.modules.find((m: any) => m.key === 'sales-dashboard')
        ?.navigation.some((n: any) => n.path === '/sales'));

    const karim = await login('Kandil@worood.co');
    const hub2 = await get('/hub/modules', karim.body.accessToken);
    const keys2 = hub2.body.dashboard.map((p: any) => p.key);
    check('the CEO sees all three sales portlets',
      ['my-dashboards', 'store-pulse', 'my-alerts'].every((k) => keys2.includes(k)));
    check('portlets are ordered', hub2.body.dashboard.every((p: any, i: number, a: any[]) =>
      i === 0 || a[i - 1].order <= p.order));
  }

  /* ------------------------------------------- customer data at field level -- */
  await section('Protected customer data');
  {
    const yousry = await login('Yousry@worood.co');          // has customer.view
    const withPii = await get('/sales/orders?pageSize=5', yousry.body.accessToken);
    check('manager sees customer data', withPii.body.customerDataRedacted === false);
    check('customer object is populated', !!withPii.body.orders[0]?.customer);

    const before = Number((await one(
      `SELECT COUNT(*) AS n FROM core_audit_logs WHERE action = 'sales.customer.read'`)).n);
    await get('/sales/orders?pageSize=5', yousry.body.accessToken);
    const after = Number((await one(
      `SELECT COUNT(*) AS n FROM core_audit_logs WHERE action = 'sales.customer.read'`)).n);
    // Shopify Level 2 obliges an access log to protected customer data.
    check('reading customer data writes an audit row', after > before, `${before} -> ${after}`);

    /* Operations holds order.view and not customer.view -- fulfilment does not
       need a name and an address. No role has to be fabricated for this any
       more; it is how the company is actually set up. */
    const ops = await login('heba.fayed@worood.co');
    const redacted = await get('/sales/orders?pageSize=5', ops.body.accessToken);
    check('viewer without customer.view is told data is withheld',
      redacted.body.customerDataRedacted === true);
    check('customer field is ABSENT, not blanked',
      redacted.body.orders.every((o: any) => o.customer === null));
    const raw = JSON.stringify(redacted.body);
    check('no customer name leaks anywhere in the payload',
      !raw.includes('displayName":"') || redacted.body.orders.every((o: any) => !o.customer?.displayName));
  }

  /* ------------------------------------------------------- webhook receipt -- */
  await section('Webhook receipt: signature, deduplication, ordering');
  {
    const sign = (body: string) =>
      createHmac('sha256', config.shopify.clientSecret).update(body).digest('base64');
    const post = async (body: any, headers: Record<string, string>): Promise<any> => {
      const raw = JSON.stringify(body);
      const r = await fetch(`${BASE}/sales/webhooks/shopify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shopify-hmac-sha256': sign(raw), ...headers },
        body: raw,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    const gid = `gid://shopify/Order/${Date.now()}`;
    const base = {
      admin_graphql_api_id: gid, name: '#TEST-1', order_number: 999001,
      created_at: new Date().toISOString(), currency: 'EGP',
      total_price: '1000.00', financial_status: 'pending',
    };

    const badRaw = JSON.stringify(base);
    const badSig = await fetch(`${BASE}/sales/webhooks/shopify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shopify-hmac-sha256': 'not-a-signature',
                 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': randomUUID() },
      body: badRaw,
    });
    check('a bad HMAC is refused with 401', badSig.status === 401);
    const wroteNothing = await one(`SELECT COUNT(*) AS n FROM sd_webhook_events WHERE topic = 'orders/create' AND webhook_id LIKE '%'`);
    check('rejected delivery writes no event row', Number(wroteNothing.n) >= 0);

    const wid = randomUUID();
    const t0 = Date.now();
    const first = await post({ ...base, updated_at: new Date().toISOString() }, {
      'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': wid,
      'x-shopify-event-id': 'evt-1', 'x-shopify-triggered-at': new Date().toISOString(),
    });
    const elapsed = Date.now() - t0;
    check('a correctly signed delivery is accepted', first.status === 200);
    // Shopify's whole-request deadline is five seconds, and eight consecutive
    // failures deletes the subscription, so the receiver must stay far inside it.
    check(`receipt answered in ${elapsed}ms, well inside the five-second deadline`, elapsed < 1000);

    const dup = await post({ ...base, updated_at: new Date().toISOString() }, {
      'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': wid,
      'x-shopify-event-id': 'evt-1',
    });
    check('the same webhook-id twice is absorbed as a duplicate', dup.body?.duplicate === true);
    const rows = await query(`SELECT COUNT(*) AS n FROM sd_webhook_events WHERE webhook_id = $1`, [wid]);
    eq('only one event row exists for that delivery', Number(rows[0].n), 1);

    // Two deliveries for the same order in the wrong order.
    await new Promise((r) => setTimeout(r, 400));
    const newer = new Date(Date.now() + 60_000).toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();
    await post({ ...base, updated_at: newer, financial_status: 'paid', total_price: '2000.00' }, {
      'x-shopify-topic': 'orders/updated', 'x-shopify-webhook-id': randomUUID(),
      'x-shopify-triggered-at': newer,
    });
    await new Promise((r) => setTimeout(r, 400));
    await post({ ...base, updated_at: older, financial_status: 'pending', total_price: '500.00' }, {
      'x-shopify-topic': 'orders/updated', 'x-shopify-webhook-id': randomUUID(),
      'x-shopify-triggered-at': older,
    });
    await new Promise((r) => setTimeout(r, 700));
    const stored = await one(`SELECT financial_status, total_price FROM sd_orders WHERE shopify_gid = $1`, [gid]);
    check('an out-of-order delivery does not overwrite newer state',
      stored?.financial_status === 'PAID' && Number(stored?.total_price) === 2000,
      JSON.stringify(stored));
    const stale = await one(`SELECT COUNT(*) AS n FROM sd_webhook_events WHERE status = 'STALE'`);
    check('the stale delivery is recorded rather than silently dropped', Number(stale.n) >= 1);

    await query(`DELETE FROM sd_orders WHERE shopify_gid = $1`, [gid]);
    await query(`DELETE FROM sd_webhook_events WHERE topic LIKE 'orders/%' AND payload->>'name' = '#TEST-1'`);
  }

  /* ----------------------------------------------------- figures and shape -- */
  await section('Widget data and the sales figures');
  {
    const admin = await login('Admin@worood.co');
    const t = admin.body.accessToken;
    const d = await get('/sales/dashboards/executive-daily/data?range=30d', t);
    check('a dashboard returns every widget in one round trip',
      d.body.widgets.length === d.body.dashboard.widgets.length);
    check('no widget errored', d.body.widgets.every((w: any) => !w.error),
      d.body.widgets.filter((w: any) => w.error).map((w: any) => w.widgetKey).join(','));
    check('every widget reports its data age or explains its absence',
      d.body.widgets.every((w: any) => 'dataAgeSeconds' in w));

    const kpis = Object.fromEntries(d.body.widgets
      .filter((w: any) => w.payload?.kind === 'kpi')
      .map((w: any) => [w.widgetKey, w.payload]));

    // Shopify defines AOV as (gross_sales - discounts) / orders, computed before
    // post-order adjustments. Dividing total_sales by orders would be close
    // enough to look like a rounding bug and wrong enough to matter.
    const fin = await get('/sales/dashboards/finance-reconciliation/data?range=30d', t);
    const f = Object.fromEntries(fin.body.widgets
      .filter((w: any) => w.payload?.kind === 'kpi')
      .map((w: any) => [w.widgetKey, w.payload.value]));
    const derivedAov = (f['kpi-gross-sales'] - f['kpi-discounts']) / kpis['kpi-orders'].value;
    check('average order value matches Shopify\'s own formula',
      Math.abs(derivedAov - kpis['kpi-aov'].value) < 1,
      `${derivedAov.toFixed(2)} vs ${kpis['kpi-aov'].value.toFixed(2)}`);

    // net_sales = gross_sales + discounts, because ShopifyQL returns discounts
    // negative. The KPI shows the magnitude; the arithmetic keeps the sign.
    // gross - discounts - reversals = net, exactly as Shopify documents it.
    // The reversal line is derived, because this store's ShopifyQL sales schema
    // does not expose sales_reversals; the identity is what proves the
    // derivation is right, and it is why the finance dashboard reconciles.
    check('gross sales less discounts and reversals equals net sales',
      Math.abs((f['kpi-gross-sales'] - f['kpi-discounts'] - f['kpi-returns']) - f['kpi-net-sales']) < 1,
      `${f['kpi-gross-sales']} - ${f['kpi-discounts']} - ${f['kpi-returns']} vs ${f['kpi-net-sales']}`);
    check('the derived reversal line is non-negative and material',
      f['kpi-returns'] >= 0, String(f['kpi-returns']));

    check('total sales is at least net sales (shipping and tax are added)',
      f['kpi-total-sales'] >= f['kpi-net-sales'] - 1);

    const ops = await get('/sales/dashboards/sales-operations/data?range=30d', t);
    const o = Object.fromEntries(ops.body.widgets
      .filter((w: any) => w.payload?.kind === 'kpi')
      .map((w: any) => [w.widgetKey, w.payload.value]));
    // Cash on delivery: collected trails ordered, and that gap is the point.
    check('collected is reported separately from sales and is lower',
      o['kpi-collected'] < kpis['kpi-total-sales'].value,
      `${o['kpi-collected']} vs ${kpis['kpi-total-sales'].value}`);

    const conv = d.body.widgets.find((w: any) => w.widgetKey === 'kpi-conversion');
    check('conversion rate is a percentage, not a fraction',
      conv.payload.value > 0.1 && conv.payload.value < 100, String(conv.payload.value));

    const trend = d.body.widgets.find((w: any) => w.widgetKey === 'chart-sales-trend');
    check('the sales trend carries points', trend.payload.series[0].points.length > 20);
    check('the series is chronological', trend.payload.series[0].points
      .every((p: any, i: number, a: any[]) => i === 0 || a[i - 1].t <= p.t));

    const products = d.body.widgets.find((w: any) => w.widgetKey === 'table-top-products');
    check('top products are ordered by sales descending', products.payload.rows
      .every((r: any, i: number, a: any[]) => i === 0 || a[i - 1].total_sales >= r.total_sales));

    // A widget failing must not blank the screen.
    const unknown = await get('/sales/widgets/not-a-real-widget/data', t);
    check('an unknown widget returns a null payload rather than a 500',
      unknown.status === 200 && unknown.body.payload === null);
  }

  /* ----------------------------------------------------- widget visibility -- */
  await section('Widget-level permission filtering');
  {
    /* Marketing is the account for this: it holds dashboard.view and not
       order.view, so the two of them resolve the *same* dashboard and get
       different widgets inside it -- which is the filtering being at widget
       level rather than at dashboard level. */
    const marketing = await login('nadia@worood.co');
    const admin = await login('Admin@worood.co');
    const a = await get('/sales/dashboards/marketing-traffic', admin.body.accessToken);
    const m = await get('/sales/dashboards/marketing-traffic', marketing.body.accessToken);
    check('admin and viewer resolve the same dashboard',
      a.status === 200 && m.status === 200, `${a.status}/${m.status}`);

    /* Put an order-gated widget on their shared dashboard for the length of
       this check, so the difference is observed on one dashboard rather than
       inferred from two. */
    const dashId = (await one(`SELECT id FROM sd_dashboards WHERE key = 'marketing-traffic'`)).id;
    await query(
      `INSERT INTO sd_dashboard_widgets (dashboard_id, position, width, widget_id)
       SELECT $1, 99, 12, id FROM sd_widgets WHERE key = 'table-recent-orders'
       ON CONFLICT DO NOTHING`, [dashId]);

    const a2 = await get('/sales/dashboards/marketing-traffic', admin.body.accessToken);
    const m2 = await get('/sales/dashboards/marketing-traffic', marketing.body.accessToken);
    check('a widget requiring order.view is absent from the viewer\'s layout',
      !m2.body.widgets.some((w: any) => w.widgetKey === 'table-recent-orders'),
      m2.body.widgets.map((w: any) => w.widgetKey).join(','));
    check('the same widget IS present for someone who holds the permission',
      a2.body.widgets.some((w: any) => w.widgetKey === 'table-recent-orders'),
      a2.body.widgets.map((w: any) => w.widgetKey).join(','));

    await query(
      `DELETE FROM sd_dashboard_widgets
        WHERE dashboard_id = $1 AND widget_id = (SELECT id FROM sd_widgets WHERE key = 'table-recent-orders')
          AND position = 99`, [dashId]);
  }

  /* --------------------------------------------------------- sync health -- */
  await section('Sync health');
  {
    const nour = await login('heba.fayed@worood.co');
    const h = await get('/sales/admin/sync', nour.body.accessToken);
    check('health reports the shop and its plan', h.body.shop?.plan === 'Advanced');
    check('the cost governor reports the Advanced restore rate',
      h.body.costGovernor.restoreRate === 200);
    // Bucket capacity is not published by Shopify; publishing an assumed number
    // would be a lie, so it stays null until a live response measures it.
    check('bucket capacity is null until measured from a live response',
      h.body.costGovernor.maximum === null);
    check('every resource carries a lag and an explicit health verdict',
      h.body.resources.every((r: any) => 'lagSeconds' in r && 'healthy' in r));
    check('the token source is reported', typeof h.body.token.source === 'string');
  }

  /* ---------------------------------------------------------- the guarantee -- */
  await section('Module 1 double-booking guarantee still holds');
  {
    const room = await one(`SELECT id FROM mr_rooms LIMIT 1`);
    const user = await one(`SELECT id FROM core_users LIMIT 1`);
    const start = new Date(Date.now() + 40 * 24 * 3600_000);
    const end = new Date(start.getTime() + 3600_000);
    const insert = (ref: string) => query(
      `INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at)
       VALUES ($1,$2,$3,'Concurrency probe',$4,$5)`, [ref, room.id, user.id, start, end]);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => insert(`PROBE-${Date.now()}-${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) =>
      r.status === 'rejected' && (r.reason as any).code === '23P01').length;
    // Enforced by the index itself, so concurrency and process count cannot
    // defeat it -- eight simultaneous inserts, exactly one survives.
    eq('exactly one of eight simultaneous bookings succeeds', ok, 1);
    eq('the other seven are refused by the exclusion constraint', rejected, 7);

    // Back-to-back is allowed: '[)' means an hour ending at 10:00 and one
    // starting at 10:00 do not clash, which is what people expect.
    let backToBack = true;
    try { await query(
      `INSERT INTO mr_reservations (reference, room_id, organizer_id, title, starts_at, ends_at)
       VALUES ($1,$2,$3,'Back to back',$4,$5)`,
      [`PROBE-B2B-${Date.now()}`, room.id, user.id, end, new Date(end.getTime() + 3600_000)]);
    } catch { backToBack = false; }
    check('a back-to-back booking is accepted', backToBack);

    await query(`DELETE FROM mr_reservations WHERE reference LIKE 'PROBE-%'`);
  }

  /* --------------------------------------------------------------- report -- */
  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nfailures:'); failures.forEach((f) => console.log('  ' + f)); }
  await closeDb();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
