/**
 * Visual check for the portal shell, against a stubbed API.
 *
 * This is not a test of the API -- it stubs it deliberately. It exists so a
 * change to the stylesheet, the theme switch or the home-screen layout can be
 * *looked at* before it is pushed, in every appearance the portal ships:
 * light, dark, right-to-left, and the customise mode.
 *
 *   node scripts/ui-screenshots.mjs            # writes ../../screenshots/ui/
 */

/* Playwright is intentionally NOT a dependency of this app: it downloads a
   browser on install, and nobody who only wants to run the portal should pay
   that. Install it when you want screenshots:
       npm i -D playwright && npx playwright install chromium          */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../screenshots/ui');
const BASE = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173';

const iso = (offsetMinutes) => new Date(Date.UTC(2026, 7, 17, 9, 0) + offsetMinutes * 60_000).toISOString();

const principal = {
  id: 'u-omar', email: 'omar.hassan@worood.co', fullName: 'Omar Hassan', fullNameAr: 'عمر حسن',
  jobTitle: 'Head of Commercial', department: 'Commercial',
  timezone: 'Africa/Cairo', locale: 'en',
  roles: ['sales-manager', 'employee'], permissions: ['sales.dashboard.view'],
};

const hub = {
  modules: [
    {
      key: 'meeting-rooms', name: 'Meeting Rooms', version: '1.0.0', enabled: true,
      navigation: [
        { label: 'Book a room', path: '/meeting-rooms/book', icon: 'calendar-plus' },
        { label: 'My reservations', path: '/meeting-rooms/reservations', icon: 'list' },
      ],
      portlets: [],
    },
    {
      key: 'sales-dashboard', name: 'Sales Dashboard', version: '1.0.0', enabled: true,
      navigation: [
        { label: 'Dashboards', path: '/sales', icon: 'trending-up' },
        { label: 'Orders', path: '/sales/orders', icon: 'receipt' },
      ],
      portlets: [],
    },
    { key: 'leave', name: 'Leave Requests', version: '0.0.0', enabled: false, comingSoon: true, navigation: [{ label: 'Leave', path: '/leave', icon: 'sun' }], portlets: [] },
    { key: 'helpdesk', name: 'Help Desk', version: '0.0.0', enabled: false, comingSoon: true, navigation: [{ label: 'Help Desk', path: '/helpdesk', icon: 'life-buoy' }], portlets: [] },
    { key: 'documents', name: 'Document Library', version: '0.0.0', enabled: false, comingSoon: true, navigation: [{ label: 'Documents', path: '/documents', icon: 'database' }], portlets: [] },
  ],
  dashboard: [
    { key: 'store-pulse', moduleKey: 'sales-dashboard', title: 'Store pulse', width: 8, order: 10 },
    { key: 'next-meeting', moduleKey: 'meeting-rooms', title: 'Next meeting', width: 4, order: 20 },
    { key: 'my-dashboards', moduleKey: 'sales-dashboard', title: 'My dashboards', width: 4, order: 30 },
    { key: 'free-now', moduleKey: 'meeting-rooms', title: 'Free right now', width: 4, order: 40 },
    { key: 'my-alerts', moduleKey: 'sales-dashboard', title: 'My alerts', width: 4, order: 50 },
    { key: 'upcoming-reservations', moduleKey: 'meeting-rooms', title: 'Upcoming reservations', width: 8, order: 60 },
  ],
};

const PORTLETS = {
  '/meeting-rooms/portlets/next-meeting': {
    meeting: {
      title: 'Q3 channel review', room: 'Nile', floor: 4, attendees: 9,
      reference: 'MR-2026-0841', startsAt: iso(75), endsAt: iso(135),
    },
  },
  '/meeting-rooms/portlets/free-now': {
    rooms: [
      { name: 'Lotus', floor: 3, capacity: 6, freeForMinutes: 95 },
      { name: 'Papyrus', floor: 3, capacity: 4, freeForMinutes: null },
      { name: 'Delta', floor: 5, capacity: 12, freeForMinutes: 40 },
    ],
  },
  '/meeting-rooms/portlets/upcoming-reservations': {
    reservations: [
      { reference: 'MR-2026-0844', title: 'Supplier call', room: 'Lotus', startsAt: iso(1500), endsAt: iso(1560) },
      { reference: 'MR-2026-0851', title: 'Weekly commercial sync', room: 'Nile', startsAt: iso(2900), endsAt: iso(2960) },
    ],
  },
  '/sales/portlets/my-dashboards': {
    dashboards: [
      { key: 'executive', name: 'Executive', description: 'Company-wide trade', dataAgeSeconds: 92, headline: { label: 'sales today', value: '486,200' } },
      { key: 'marketing', name: 'Marketing', description: 'Sessions and sources', dataAgeSeconds: 92, headline: null },
    ],
  },
  '/sales/portlets/store-pulse': {
    shopName: 'Worood Cairo', businessDate: '2026-08-17', currency: 'EGP',
    dataAgeSeconds: 92, provisional: true,
    metrics: [
      { key: 'sales', label: 'Sales', value: 486200, comparedTo: 431900, comparisonLabel: 'same time last week', format: 'money' },
      { key: 'collected', label: 'Collected', value: 291400, comparedTo: 302100, comparisonLabel: 'same time last week', format: 'money' },
      { key: 'orders', label: 'Orders', value: 214, comparedTo: 198, comparisonLabel: 'same time last week', format: 'integer' },
      { key: 'aov', label: 'Average order', value: 2272, comparedTo: 2181, comparisonLabel: 'same time last week', format: 'money' },
    ],
  },
  '/sales/portlets/my-alerts': {
    unread: 2,
    alerts: [
      { id: 'a1', severity: 'WARNING', title: 'Fulfilment slipping in Giza', body: '14 orders past their promised date.', createdAt: iso(-180), readAt: null },
      { id: 'a2', severity: 'INFO', title: 'Executive dashboard shared with you', body: null, createdAt: iso(-900), readAt: iso(-800) },
    ],
  },
};

async function stub(page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/auth/login' || p === '/auth/refresh') {
      return json({ accessToken: 'stub-access', refreshToken: 'stub-refresh', expiresIn: 900, principal });
    }
    if (p === '/auth/me') return json(principal);
    if (p === '/auth/logout') return json({});
    if (p === '/hub/modules') return json(hub);
    if (PORTLETS[p]) return json(PORTLETS[p]);
    return json({ error: { message: `No stub for ${p}` } }, 404);
  });
  /* The live channel is not part of what we are looking at. */
  await page.route('**/socket.io/**', (route) => route.abort());
}

async function shot(page, name) {
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}.png`);
}

async function signIn(page) {
  await page.goto(BASE + '/login');
  await page.fill('input[type="email"]', principal.email);
  await page.fill('input[type="password"]', 'whatever');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.profile__name', { timeout: 10_000 });
}

const run = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  for (const [label, viewport] of [['', { width: 1440, height: 1000 }], ['narrow', { width: 430, height: 900 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await stub(page);

    const suffix = label ? `-${label}` : '';
    await page.goto(BASE + '/login');
    await shot(page, `login${suffix}`);

    await signIn(page);
    await shot(page, `home-light${suffix}`);

    /* Theme: light -> dark. */
    await page.click('.pref:has-text("Light"), .pref:has-text("System")');
    await page.waitForTimeout(200);
    if (await page.locator('.pref:has-text("Dark")').count() === 0) {
      await page.click('.topbar__prefs .pref >> nth=0');
    }
    await shot(page, `home-dark${suffix}`);

    /* Back to light, then Arabic. */
    while (await page.locator('.pref:has-text("Light")').count() === 0) {
      await page.click('.topbar__prefs .pref >> nth=0');
      await page.waitForTimeout(150);
    }
    await page.click('.topbar__prefs .pref >> nth=1');
    await shot(page, `home-rtl${suffix}`);
    await page.click('.topbar__prefs .pref >> nth=1');

    if (!label) {
      await page.click('button:has-text("Customise")');
      await shot(page, 'home-customise');
      await page.click('.cellbar >> nth=2 >> button[title="Hide this card"]');
      await shot(page, 'home-customise-hidden');
    }

    await context.close();
  }

  await browser.close();
  console.log(`\nWritten to ${OUT}`);
};

run().catch((err) => { console.error(err); process.exit(1); });
