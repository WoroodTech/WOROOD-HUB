/* Screenshots of tasks & tickets against the real API.
   npm i -D playwright && npx playwright install chromium

   Run the API and `vite preview` first:
     cd apps/api && npm run seed -- --reset && node dist/main.js &
     cd apps/web && npm run build && npx vite preview --port 4173 &
     node scripts/shot-tasks.mjs

   Three accounts, because the module looks different from each and that is
   the point: Nadia raises work she does not control, Omnia hands work out,
   Youssef does it. */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4173';
const API = 'http://127.0.0.1:3000';
const OUT = process.env.OUT || 'screenshots/ui';

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();

await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url());
  const req = route.request();
  const res = await fetch(API + url.pathname + url.search, {
    method: req.method(),
    headers: { ...req.headers(), host: '127.0.0.1:3000' },
    body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
  });
  route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
});
await page.route('**/socket.io/**', (r) => r.abort());

const shot = async (n) => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  console.log('  ✓', n);
};

async function signIn(email) {
  await ctx.clearCookies();
  await page.goto(BASE + '/login');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'Worood@2026');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.profile__name', { timeout: 15000 });
}

/* The requester: sees her own request and, if it is blocked, which department
   it is waiting on -- and nothing of that department's ticket. */
await signIn('nadia@worood.co');
await page.goto(BASE + '/'); await shot('tasks-home-requester');
await page.goto(BASE + '/tasks'); await shot('tasks-list-requester');

/* The manager: the queue is the first thing on her home screen, because a
   ticket with nobody on it is the only kind the requester cannot chase. */
await signIn('omnia.osama@worood.co');
await page.goto(BASE + '/'); await shot('tasks-home-manager');
await page.goto(BASE + '/tasks/queue'); await shot('tasks-queue');
const first = await page.$('.taskrow');
if (first) { await first.click(); await shot('tasks-detail-manager'); }

/* The person doing the work. */
await signIn('youssef.samir@worood.co');
await page.goto(BASE + '/tasks'); await shot('tasks-list-assignee');
const mine = await page.$('.taskrow');
if (mine) { await mine.click(); await shot('tasks-detail-assignee'); }

/* Right-to-left, because the stylesheet is written in logical properties and
   the claim that it mirrors for free should be checked rather than asserted. */
await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
await shot('tasks-detail-rtl');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await shot('tasks-detail-dark');

await b.close();
console.log(`\nwritten to ${OUT}/`);
