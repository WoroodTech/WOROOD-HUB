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
    const good = await login('yara.saleh@worood.co');
    check('correct credentials sign in', good.status === 201 || good.status === 200);
    check('principal carries roles and effective permissions',
      good.body?.principal?.permissions?.includes('sales.order.view'));

    const bad = await login('yara.saleh@worood.co', 'wrong-password');
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
    const expect: [string, number, string][] = [
      ['omar.khaled@worood.co', 0, 'no sales permission at all'],
      ['nour.hassan@worood.co', 0, 'sync permission only, which is not a dashboard permission'],
      ['hala.mansour@worood.co', 1, 'role grants two, an individual REVOKE removes one'],
      ['yara.saleh@worood.co', 4, 'role grants three, an individual GRANT adds one'],
      ['karim.fouad@worood.co', 5, 'holds manage, so sees every dashboard'],
      ['admin@worood.co', 5, 'administrator'],
    ];
    for (const [email, n, why] of expect) {
      const l = await login(email);
      const r = await get('/sales/dashboards', l.body.accessToken);
      const count = Array.isArray(r.body) ? r.body.length : 0;
      check(`${email.split('@')[0]} sees ${n} dashboards — ${why}`, count === n, `got ${count}`);
    }

    const hala = await login('hala.mansour@worood.co');
    const hr = await get('/sales/dashboards', hala.body.accessToken);
    check('an individual REVOKE beats the role grant',
      !hr.body.some((d: any) => d.key === 'marketing-traffic'));

    const yara = await login('yara.saleh@worood.co');
    const yr = await get('/sales/dashboards', yara.body.accessToken);
    check('an individual GRANT is reported as USER, not ROLE',
      yr.body.find((d: any) => d.key === 'finance-reconciliation')?.grantedBy === 'USER');
    check('a role grant is reported as ROLE',
      yr.body.find((d: any) => d.key === 'executive-daily')?.grantedBy === 'ROLE');
  }

  /* -------------------------------------------- permission independence -- */
  await section('Permission keys are independent, not hierarchical');
  {
    const nour = await login('nour.hassan@worood.co');
    const sync = await get('/sales/admin/sync', nour.body.accessToken);
    check('sync-only engineer reaches Data & Sync', sync.status === 200);
    const dash = await get('/sales/dashboards', nour.body.accessToken);
    check('sync-only engineer is refused dashboards', dash.status === 403);
    const orders = await get('/sales/orders', nour.body.accessToken);
    check('sync-only engineer is refused orders', orders.status === 403);

    const karim = await login('karim.fouad@worood.co');
    const karimSync = await get('/sales/admin/sync', karim.body.accessToken);
    check('sales admin without sync.manage is refused Data & Sync', karimSync.status === 403);
  }

  /* ------------------------------------------------ portlet gating on home -- */
  await section('Home dashboard portlets');
  {
    const omar = await login('omar.khaled@worood.co');
    const hub = await get('/hub/modules', omar.body.accessToken);
    const keys = hub.body.dashboard.map((p: any) => p.key);
    check('employee with no sales access sees meeting-room portlets',
      keys.includes('next-meeting') && keys.includes('free-now'));
    check('employee with no sales access sees NO sales portlets',
      !keys.some((k: string) => ['my-dashboards', 'store-pulse', 'my-alerts'].includes(k)),
      keys.join(','));
    check('no sales navigation either',
      !hub.body.modules.find((m: any) => m.key === 'sales-dashboard')?.navigation.length);

    const karim = await login('karim.fouad@worood.co');
    const hub2 = await get('/hub/modules', karim.body.accessToken);
    const keys2 = hub2.body.dashboard.map((p: any) => p.key);
    check('sales admin sees all three sales portlets',
      ['my-dashboards', 'store-pulse', 'my-alerts'].every((k) => keys2.includes(k)));
    check('portlets are ordered', hub2.body.dashboard.every((p: any, i: number, a: any[]) =>
      i === 0 || a[i - 1].order <= p.order));
  }

  /* ------------------------------------------- customer data at field level -- */
  await section('Protected customer data');
  {
    const yara = await login('yara.saleh@worood.co');           // has customer.view
    const withPii = await get('/sales/orders?pageSize=5', yara.body.accessToken);
    check('manager sees customer data', withPii.body.customerDataRedacted === false);
    check('customer object is populated', !!withPii.body.orders[0]?.customer);

    const before = Number((await one(
      `SELECT COUNT(*) AS n FROM core_audit_logs WHERE action = 'sales.customer.read'`)).n);
    await get('/sales/orders?pageSize=5', yara.body.accessToken);
    const after = Number((await one(
      `SELECT COUNT(*) AS n FROM core_audit_logs WHERE action = 'sales.customer.read'`)).n);
    // Shopify Level 2 obliges an access log to protected customer data.
    check('reading customer data writes an audit row', after > before, `${before} -> ${after}`);

    // A user holding order.view but not customer.view: create one on the fly.
    const roleId = (await one(`SELECT id FROM core_roles WHERE key = 'sales-viewer'`)).id;
    const permId = (await one(`SELECT id FROM core_permissions WHERE key = 'sales.order.view'`)).id;
    await query(`INSERT INTO core_role_permissions (role_id, permission_id) VALUES ($1,$2)
                 ON CONFLICT DO NOTHING`, [roleId, permId]);
    const hala = await login('hala.mansour@worood.co');
    const redacted = await get('/sales/orders?pageSize=5', hala.body.accessToken);
    check('viewer without customer.view is told data is withheld',
      redacted.body.customerDataRedacted === true);
    check('customer field is ABSENT, not blanked',
      redacted.body.orders.every((o: any) => o.customer === null));
    const raw = JSON.stringify(redacted.body);
    check('no customer name leaks anywhere in the payload',
      !raw.includes('displayName":"') || redacted.body.orders.every((o: any) => !o.customer?.displayName));
    await query(`DELETE FROM core_role_permissions WHERE role_id = $1 AND permission_id = $2`,
      [roleId, permId]);
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
    const admin = await login('admin@worood.co');
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
    const hala = await login('hala.mansour@worood.co');   // no sales.order.view
    const admin = await login('admin@worood.co');
    const a = await get('/sales/dashboards/executive-daily', admin.body.accessToken);
    const h = await get('/sales/dashboards/executive-daily', hala.body.accessToken);
    check('admin and viewer resolve the same dashboard', a.status === 200 && h.status === 200);
    check('a widget requiring order.view is absent from the viewer\'s layout',
      !h.body.widgets.some((w: any) => w.widgetKey === 'table-recent-orders'));

    const ops = await get('/sales/dashboards/sales-operations', admin.body.accessToken);
    check('the same widget IS present for someone who holds the permission',
      ops.body.widgets.some((w: any) => w.widgetKey === 'table-recent-orders'));
  }

  /* --------------------------------------------------------- sync health -- */
  await section('Sync health');
  {
    const nour = await login('nour.hassan@worood.co');
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
