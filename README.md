# WOROOD HUB

An enterprise intranet portal built as a small platform with modules installed into it.

- **Module 1 — Meeting Rooms** (`mr_*`): the full flow — availability search, booking,
  amendment and cancellation, and room administration with per-room booking policy.
  Double-booking is prevented by a GiST exclusion constraint in the database rather
  than by application code. Colleagues can be invited from the employee directory,
  and the meeting appears on their own home screen with Accept and Decline. See
  [`docs/MODULE-1-BOOKING.md`](docs/MODULE-1-BOOKING.md).
- **Module 2 — Sales Dashboard** (`sd_*`): the Shopify sales dashboard, built to
  `WOROOD-HUB-Module-2-Sales-Dashboard.md`.

Every figure on a sales dashboard in this build comes from **real Worood store data**,
captured read-only from `worood-designs.myshopify.com`: 396 days of ShopifyQL sales and
sessions series, product, traffic, device and country breakdowns, and 150 recent orders
with their line items, refunds and customers.

The portal ships **light, dark and system** colour schemes, a **right-to-left** layout for
Arabic, and a home screen each employee can rearrange for themselves. What was merged into
this repository and why the UI looks the way it does is recorded in
[`docs/UI-CONSOLIDATION-AND-ENHANCEMENTS.md`](docs/UI-CONSOLIDATION-AND-ENHANCEMENTS.md).

The mark is traced from Worood's own artwork rather than approximated; how, and
why the brand gold is kept separate from the interface accent, is in
[`docs/BRAND-AND-ACCOUNTS.md`](docs/BRAND-AND-ACCOUNTS.md) — which also explains
the six demonstration accounts and the permissions each one holds.

`prototypes/` holds the two earlier explorations — the meeting-rooms prototype and the
standalone employee dashboard — kept as a record of how the design arrived here. Nothing
in `apps/` imports from them.

---

## Running it

Requires Node 22, PostgreSQL 16 and Redis.

```bash
# 1. database and cache
createdb worood_hub
psql worood_hub -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
                    CREATE EXTENSION IF NOT EXISTS btree_gist;
                    CREATE EXTENSION IF NOT EXISTS citext;'
redis-server --daemonize yes

# 2. configuration
cp .env.example .env      # then set DATABASE_URL and JWT_SECRET
bash scripts/sync-contract.sh

# 3. API
cd apps/api
npm install
npm run migrate          # checksum-verified, idempotent
npm run seed -- --reset  # people, rooms, widgets, dashboards, Shopify fixtures
npm run build && npm start          # http://localhost:3000

# 5. tests
npx tsx test/slots.test.ts          # booking arithmetic, no database needed
npx tsx test/booking.test.ts        # end-to-end, needs the API above running
npx tsx test/invitations.test.ts    # inviting colleagues, and their home screen
npx tsx test/administration.test.ts # people, roles and dashboard assignment

# 4. portal
cd ../web
npm install
npm run dev              # http://localhost:5173
```

Configuration comes from the environment. In production the systemd unit supplies an
`EnvironmentFile`; locally there is no systemd, so `src/common/load-env.ts` reads the
repo-root `.env` and fills only variables that are not already set — the real
environment always wins, so systemd, Docker and CI are unaffected. Point it elsewhere
with `ENV_FILE=/path/to/file`. Without a `.env` the process falls back to the defaults
in `src/common/config.ts`, which will not match your database password.

### Managing people, roles and dashboard access

**Administration → People** and **Administration → Roles**, visible only to
accounts holding `core.user.manage` / `core.role.manage` — the `admin` role.
Create accounts, change a name, e-mail address or password, hold and remove
roles, and assign or block individual dashboards. Role-wide dashboard grants
stay in **Sales → Manage Dashboards**, since they belong to the dashboard.

The console refuses to let an administrator lock everybody out — including
themselves — and every refusal says what to do first.
[`docs/ADMINISTRATION.md`](docs/ADMINISTRATION.md) has the model, the rails and
the SQL escape hatch for an install with no administrator left.

### Upgrading an install that is already running

`npm run migrate` is enough to get the booking flow working: migration `0004` is
additive, gives every existing room a code and the default booking policy, and
moves its fittings into the new catalogue. Nothing is lost and no data is
rewritten.

Re-seeding is optional and **destructive** — `npm run seed -- --reset` truncates
the demo tables. Do it if you want the demonstration data the screenshots show,
where each room has a deliberately different policy: the Training Hall takes
hour-long blocks with a 30-minute changeover, Jasmine is a 15-minute huddle
grid, and the Studio holds its bookings for approval.

Redis is only used by the sales dashboard's live channel. Without it the API
logs a connection warning on a loop and everything else, booking included, works
normally.

Then sign in with any of the accounts below. **Password for every account: `Worood@2026`.**

| Account | Who they are | What they see |
|---|---|---|
| `omnia.osama@worood.co` | Omnia Osama — Customer Care | Orders, with customer identity, because answering the phone means knowing who is on it. **No dashboard permission at all** — the sales portlets are absent from her home screen, not empty. This is the permission gate, and it should be visibly true. |
| `nadia@worood.co` | Nadia — Marketing Director | Marketing dashboards, and **no orders at all**: a campaign is not a reason to read a customer's address. Her role reaches two dashboards; an individual `REVOKE` takes one back. |
| `Yousry@worood.co` | Mohamed Yousry — Financial Manager | Finance reconciliation and the daily figures, with orders and customers. |
| `heba.fayed@worood.co` | Heba Fayed — Operations Manager | Room administration, anyone's reservation, order flow and Data & Sync — but **not** the dashboard composer, and orders arrive with the customer withheld. One dashboard from her role, one from an individual `GRANT`. |
| `Kandil@worood.co` | Mohamed Kandil — Chief Executive Officer | All five dashboards, orders and customers. **No Data & Sync and no administration console** — the keys are independent, so the widest reading permission still does not imply an operational one. |
| `Admin@worood.co` | Khalid Hesham — System Administrator | Everything, including People and Roles. |

Between them these six cover every branch of the resolution rule: a role that
reaches several dashboards, roles that reach exactly one, a role that reaches
none, a dashboard added to one person, and a dashboard taken back from one
person. Nothing is inherited from anything else.

Tests, with the API running:

```bash
cd apps/api && npm test        # 68 assertions
```

---

## What is where

```
worood-hub/
├── apps/
│   ├── api/                          NestJS 10
│   │   ├── src/
│   │   │   ├── common/               config · db · auth guards · error filter
│   │   │   ├── core/                 auth · RBAC · audit · notifications · hub registry · health
│   │   │   ├── modules/
│   │   │   │   ├── meeting-rooms/    Module 1 descriptor and portlets
│   │   │   │   └── sales-dashboard/  Module 2
│   │   │   │       ├── descriptor.ts        one declaration; nav, portlets and permissions derive from it
│   │   │   │       ├── shopify/             token manager · cost governor · live and fixture sources
│   │   │   │       ├── analytics/           ShopifyQL capture into snapshots
│   │   │   │       ├── metrics/             the 20 widget payloads
│   │   │   │       ├── dashboards/          access resolution · composition · orders
│   │   │   │       ├── portlets/            the three personal home-screen portlets
│   │   │   │       ├── webhooks/            HMAC guard · receipt · mirror application
│   │   │   │       ├── sync/                reconciliation · watchdog · retention · health
│   │   │   │       └── realtime/            Socket.IO gateway
│   │   │   └── db/                   migrations · checksum runner · seeder
│   │   └── test/run.ts               the verification suite
│   └── web/                          React + Vite portal
├── packages/contract/index.ts        every payload shape, declared once
├── fixtures/shopify/                 real data captured from the live store
├── deploy/                           nginx · systemd · redis
└── screenshots/
```

`packages/contract/index.ts` is the single source of truth for anything crossing the
network. It is type-only, so `scripts/sync-contract.sh` copies it into both apps rather
than resolving it through a path alias — no runtime resolver, no build step.

---

## The parts worth reading first

**`src/core/hub-registry.ts`** — the module contract. A module declares one descriptor
and the platform derives the sidebar (filtered per employee), the home portlet grid, the
permission rows and the `GET /hub/modules` response. The portal has no hard-coded menu.

**`modules/sales-dashboard/dashboards/access.service.ts`** — which dashboards an employee
gets: role defaults, plus individual grants, minus individual revocations, with
`sales.dashboard.manage` short-circuiting to everything. Resolved from PostgreSQL on
every request and never cached in the token, which is what makes an unassignment take
effect on the next request with no logout.

**`modules/sales-dashboard/metrics/metrics.service.ts`** — the rule the whole design
rests on: *aggregates come from the ShopifyQL snapshots, individual records come from the
order mirror.* A headline figure is never computed by summing mirrored orders when a
snapshot metric exists, because that means reimplementing Shopify's formula and being
wrong in a way nobody can explain.

**`modules/sales-dashboard/webhooks/`** — receipt in ~7 ms (Shopify's whole-request
deadline is five seconds and eight consecutive failures deletes the subscription),
deduplication at the database on `webhook_id`, and an ordering guard, because Shopify
guarantees no ordering within or across topics.

---

## Two things this build learned from the real store

**`sales_reversals` does not exist.** Shopify documents
`net_sales = gross_sales − discounts − sales_reversals`, but this store's ShopifyQL sales
schema has no such column — the capture had to drop it, and the identity then failed by
about EGP 492,000 over thirty days. Rather than leave the finance view unable to
reconcile, the reversal line is **derived** from Shopify's own identity
(`(gross + discounts) − net`, discounts arriving negative) and shipped as its own widget.
A test asserts the identity closes. If Shopify later exposes the column, prefer it and
delete the derivation.

**Cash on delivery changes the honest headline.** Most Worood orders sit in `PENDING`
with `net_payment` at zero while `total_price` is large. A revenue metric defined as
"money received" would report a near-empty dashboard on a busy day. Every relevant screen
therefore shows two figures and labels them: **sales** (ordered, from the snapshots) and
**collected** (received, from the mirror). The gap is money in transit with the couriers,
and on a courier-heavy business it is the most operationally interesting number on the
screen.

---

## Going live against Shopify

The Shopify layer sits behind a `ShopifySource` interface with `LiveShopifySource` and
`FixtureShopifySource`. Fixture mode is the default here and makes no network calls.

```bash
SHOPIFY_TOKEN_STRATEGY=client_credentials   # or 'offline'
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...                   # also the webhook HMAC key
SHOPIFY_SHOP_DOMAIN=worood-designs.myshopify.com
SHOPIFY_API_VERSION=2026-07
SHOPIFY_COST_RESTORE_RATE=200               # Advanced plan
```

Before that works, three things from §14 of the design document:

1. Create the app in the **Dev Dashboard** with **custom distribution**. The distribution
   method is set once and can never be changed, and custom distribution is what makes
   Level 2 protected customer data available without review or plan dependency.
2. Check whether the Worood store sits in the same Shopify organisation as the app. If it
   does, the client credentials grant works with no install flow. If not, install through
   the custom-distribution link instead — the token manager handles either.
3. Expect the token to expire every 24 hours. The token manager caches it in Redis, takes
   a lock around the refresh so a burst of workers causes one HTTP request rather than
   twenty, and refreshes ahead of expiry. It is the component whose failure is least
   visible and most total, so it has its own monitoring line.

---

## Deviations from the design document, recorded deliberately

**Drizzle → parameterised SQL through `pg`.** The doc specifies Drizzle. This build uses
`pg` with parameterised SQL. What mattered in the doc's reasoning is preserved —
migrations are hand-written SQL applied by a checksum-verified runner, so what is in
version control is exactly what runs — and every analytics query here is raw SQL anyway,
which is what Drizzle's `sql` template would have produced. Swapping Drizzle back in is
mechanical; the table shapes are already fixed by the migrations.

**Permission-gated portlets are a core-platform addition.** Module 1 filtered navigation
by permission but not portlets, because every employee may see their own next meeting.
The sales portlets must be invisible to employees with no sales access, so
`HubPortletEntry.requiresAnyPermission` was added to the registry and is filtered in the
same place navigation already was. It is a handful of lines in the core, it is the only
change to shared code Module 2 needed, and every later module will want it.

**Queue.** Webhook jobs go onto a Redis list and are processed in-process, so a
single-process demo stays live. BullMQ is a dependency and slots in behind the same two
methods (`enqueue` / `processOne`) when the separate worker unit is deployed.

**The worker process.** `deploy/systemd/worood-hub-worker.service` is provided, but in
this build the schedulers are not started — reconciliation, snapshot capture, the
subscription watchdog and the retention sweep are exposed as endpoints under
`/api/v1/sales/admin/sync` and can be triggered from the Data & Sync screen.

---

## Verification

`npm test` runs 68 assertions against the live API with a real PostgreSQL and Redis,
because the properties that matter cannot be proven with mocks:

- Cairo range arithmetic, including that a Cairo day begins at 21:00 UTC the previous
  evening, and a daylight-saving boundary
- login, lockout, refresh rotation, and refresh-replay revoking the session
- the full access-resolution matrix across six accounts, including that an individual
  `REVOKE` beats a role grant and that `grantedBy` reports *why*
- permission independence: the sync-only engineer reaches Data & Sync and is refused
  everywhere else; the sales admin without `sync.manage` is refused Data & Sync
- an employee with no sales access sees the meeting-room portlets and none of the sales
  ones
- customer data absent rather than blanked, and an audit row written whenever it *is*
  returned — which is what discharges Shopify's Level 2 access-log obligation
- webhook HMAC over raw bytes, receipt inside the deadline (measured at 7 ms), duplicate
  absorbed by the database, and an out-of-order delivery not overwriting newer state
- the sales identities: average order value against Shopify's own formula, and gross less
  discounts less reversals equalling net
- Module 1's double-booking guarantee: eight simultaneous inserts, exactly one survives,
  seven refused by the exclusion constraint, and a back-to-back booking accepted
