import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4173';
const OUT = '/root/worood-hub/screenshots/ui';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();

// Proxy the portal's API calls to the real API running on :3000.
await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url());
  const target = 'http://127.0.0.1:3000' + url.pathname + url.search;
  const req = route.request();
  const res = await fetch(target, {
    method: req.method(),
    headers: { ...req.headers(), host: '127.0.0.1:3000' },
    body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
  });
  route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
});
await page.route('**/socket.io/**', (r) => r.abort());

const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('  ✓', n); };

async function signIn(email) {
  await page.goto(BASE + '/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'Worood@2026');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.profile__name', { timeout: 15000 });
}

await signIn('facilities@worood.co');
await shot('mr-home');

await page.goto(BASE + '/meeting-rooms/book');
await page.waitForSelector('.slots, .state', { timeout: 15000 });
await shot('mr-book');

// Pick a slot and open the confirmation.
const slot = page.locator('.slot').first();
if (await slot.count()) {
  await slot.click();
  await page.waitForSelector('.modal__panel');
  await page.fill('#confirm-title ~ * input, .modal__body input.input', 'Autumn range review');
  await shot('mr-book-confirm');
  await page.click('.modal__foot .btn--ghost');
}

await page.goto(BASE + '/meeting-rooms/reservations');
await page.waitForSelector('.bookings, .state', { timeout: 15000 });
await shot('mr-reservations');

await page.goto(BASE + '/meeting-rooms/admin');
await page.waitForSelector('.table, .state', { timeout: 15000 });
await shot('mr-admin');

await page.click('.rowactions .iconbtn');
await page.waitForSelector('.modal__panel--wide');
await shot('mr-admin-form');

await b.close();
