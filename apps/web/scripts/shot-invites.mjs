/* The invitation flow, against the real API.
   npm i -D playwright && npx playwright install chromium */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4173', API = 'http://127.0.0.1:3000';
const OUT = '/root/worood-hub/screenshots/ui';

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();

await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url()), req = route.request();
  const res = await fetch(API + url.pathname + url.search, {
    method: req.method(), headers: { ...req.headers(), host: '127.0.0.1:3000' },
    body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
  });
  route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
});
await page.route('**/socket.io/**', (r) => r.abort());

const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log('  ✓', n); };

const signIn = async (email) => {
  await page.goto(BASE + '/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'Worood@2026');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.profile__name', { timeout: 15000 });
};

// The organiser books, and invites two colleagues.
await signIn('yara.saleh@worood.co');
await page.goto(BASE + '/meeting-rooms/book');
await page.waitForSelector('.slot', { timeout: 15000 });
await page.locator('.slot').first().click();
await page.waitForSelector('.modal__panel');
await page.fill('.modal__body input.input', 'Autumn range review');
await page.fill('.attendees input.input', 'Omar');
await page.waitForSelector('.attendees__result', { timeout: 10000 });
await page.locator('.attendees__result').first().click();
await page.fill('.attendees input.input', 'Hala');
await page.waitForSelector('.attendees__result', { timeout: 10000 });
await page.locator('.attendees__result').first().click();
await shot('invite-picker');
await page.click('.modal__foot .btn--primary');
await page.waitForSelector('.bookings, .awaiting', { timeout: 15000 });
await shot('invite-organiser-view');

// The guest signs in and finds it waiting.
await page.click('button:has-text("Sign out")');
await page.waitForSelector('input[type="email"]', { timeout: 15000 });
await signIn('omar.khaled@worood.co');
await shot('invite-guest-home');

await page.goto(BASE + '/meeting-rooms/reservations');
await page.waitForSelector('.awaiting', { timeout: 15000 });
await shot('invite-guest-reservations');

await b.close();
