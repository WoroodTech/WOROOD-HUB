/* Screenshots of the administration console against the real API.
   npm i -D playwright && npx playwright install chromium */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4173';
const API = 'http://127.0.0.1:3000';
const OUT = '/root/worood-hub/screenshots/ui';

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await b.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();

await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url());
  const req = route.request();
  const res = await fetch(API + url.pathname + url.search, {
    method: req.method(),
    headers: { ...req.headers(), host: '127.0.0.1:3000' },
    body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
  });
  route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
});
await page.route('**/socket.io/**', (r) => r.abort());

const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('  ✓', n); };

await page.goto(BASE + '/login');
await page.fill('input[type="email"]', 'Admin@worood.co');
await page.fill('input[type="password"]', 'Worood@2026');
await page.click('button[type="submit"]');
await page.waitForSelector('.profile__name', { timeout: 15000 });

const nav = await page.locator('.sidebar__nav .navitem').allInnerTexts();
console.log('  admin sidebar:', nav.join(' | '));

await page.goto(BASE + '/admin/people');
await page.waitForSelector('.person', { timeout: 15000 });
await page.click('.person:has-text("Heba")');
await page.waitForSelector('.grantlist', { timeout: 15000 });
await shot('admin-people');

await page.click('button:has-text("Set password")');
await page.waitForSelector('.modal__panel');
await shot('admin-password');
await page.click('.modal__foot .btn--ghost');

await page.click('button:has-text("New person")');
await page.waitForSelector('.modal__panel--wide');
await shot('admin-new-person');
await page.click('.modal__foot .btn--ghost');

await page.goto(BASE + '/admin/roles');
await page.waitForSelector('.rolerow', { timeout: 15000 });
await page.click('.rolerow:has-text("Operations")');
await page.waitForSelector('.permgroup', { timeout: 15000 });
await shot('admin-roles');

await b.close();
