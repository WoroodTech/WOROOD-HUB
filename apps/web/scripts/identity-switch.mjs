/**
 * The bug this exists to prevent: signing in as a second employee and seeing
 * the first one's navigation and figures, served from a query cache keyed by
 * endpoint rather than by person.
 *
 * It drives a real browser against the real API and asserts on what is *on the
 * screen* immediately after each sign-in -- before any refetch could have
 * landed. Asserting on the cache would be asserting on the fix; asserting on
 * the pixels is asserting on the symptom.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/identity-switch.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173';
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();

await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url());
  const req = route.request();
  const res = await fetch(API + url.pathname + url.search, {
    method: req.method(),
    headers: { ...req.headers(), host: new URL(API).host },
    body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
  });
  route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
});
await page.route('**/socket.io/**', (r) => r.abort());

const signIn = async (email) => {
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'Worood@2026');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.profile__name', { timeout: 15000 });
};

const nav = () => page.locator('.sidebar__nav .navitem').allInnerTexts();
const who = () => page.locator('.who__name').innerText();

console.log('\nidentity switch');

/* Khalid is the administrator: dashboards, orders, the composer, and the
   People and Roles screens nobody else reaches. Omnia is Customer Care: orders
   and nothing else from the sales module, and no administration at all. The
   gap between the two is what a leaked cache would show. */
await page.goto(BASE + '/login');
await signIn('Admin@worood.co');
const adminNav = await nav();
check('an administrator sees the dashboard composer',
  adminNav.some((t) => /Manage Dashboards/i.test(t)), adminNav.join(' | '));
check('...and the People screen',
  adminNav.some((t) => /People/i.test(t)), adminNav.join(' | '));

// Land on a sales screen, so "back to where we were" has something to get wrong.
await page.goto(BASE + '/sales');
await page.waitForSelector('.pagehead__title', { timeout: 15000 });

await page.click('button:has-text("Sign out")');
await page.waitForSelector('input[type="email"]', { timeout: 15000 });

// Omnia: Customer Care. Orders, and no dashboard permission of any kind.
await signIn('omnia.osama@worood.co');

check('the new sign-in lands on home, not the last session’s page',
  new URL(page.url()).pathname === '/', page.url());
check('the top bar names the person who just signed in',
  (await who()).includes('Omnia'), await who());

const careNav = await nav();
check('the narrower account sees none of the administration navigation',
  !careNav.some((t) => /People|Roles|Manage Dashboards|Data & Sync/i.test(t)), careNav.join(' | '));
check('...nor the dashboards it holds no permission for',
  !careNav.some((t) => /^\s*Sales\s*$/.test(t)), careNav.join(' | '));

const cards = await page.locator('.card__title').allInnerTexts();
check('and no sales portlets are left on screen from the previous session',
  !cards.some((t) => /Store pulse|My dashboards|My alerts/i.test(t)), cards.join(' | '));
check('their own portlets did render, so this is not just an empty page',
  cards.some((t) => /meeting|Free|reservation|Quick/i.test(t)), cards.join(' | '));

await page.screenshot({ path: '/root/worood-hub/screenshots/ui/identity-switch-after.png', fullPage: true });

// And back the other way: the employee's narrower view must not stick.
await page.click('button:has-text("Sign out")');
await page.waitForSelector('input[type="email"]', { timeout: 15000 });
await signIn('Admin@worood.co');
const again = await nav();
check('switching back restores the wider account’s navigation',
  again.some((t) => /Manage Dashboards/i.test(t)) && again.some((t) => /People/i.test(t)),
  again.join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed`);
await b.close();
if (fail) process.exit(1);
