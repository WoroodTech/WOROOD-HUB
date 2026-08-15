# WOROOD HUB — Technical Design Document

**Module 2: Sales Dashboard (Shopify)**
Version 1.1 · 10 August 2026 · Prepared for Worood Technology

*Revision 1.1: Shopify plan confirmed as Advanced, and the decision taken to create a new app rather than reuse an existing one. Sections 2.2, 4.8, 4.9, 4.10, 11, 12.4, 14 and 15 updated accordingly; §4.9 rewritten around the custom-distribution app and the token manager.*

Companion to `WOROOD-HUB-Technical-Design.md` (Module 1: Meeting Room Reservation System)
and `WOROOD-HUB-Dashboard-Implementation.md` (the employee home screen).

---

## 1. Purpose and scope

This document takes the submitted *Shopify sales dashboard — architecture reference* and rebuilds it as **Module 2 of WOROOD HUB**, following the module contract established in the Module 1 design document (§3.3). It is both a review of that draft and its replacement.

The draft was written as a standalone system: its own login, its own user and role tables, its own session store, its own dashboard-and-widget model. Every one of those already exists in WOROOD HUB and is already in production use by Module 1. Reimplementing them would not merely duplicate work — it would give Worood two identity systems, two permission models and two places to add an employee, which is precisely the outcome the platform architecture was designed to prevent. Roughly half the submitted document therefore disappears into the core platform, and what is left becomes a much smaller, sharper module: **fetch Shopify data reliably, store it correctly, and present it to the right people.**

Alongside that reduction, the draft is upgraded in the places where it was thin or where its factual premises no longer hold. Several of its assumptions about the Shopify platform were true when the pattern was established but are not true in August 2026, and one of them — the claim that sessions and conversion data are not retrievable through the API — would have led the build in an expensive wrong direction. Section 2 lists every change; sections 4 and 5 carry the substance.

### 1.1 The distinction that shapes everything below

There are **two different dashboards** in play, and the draft conflated them. Keeping them apart is the single most important structural decision in this document.

**The WOROOD HUB home dashboard is personal.** It is the screen an employee lands on after signing in, and everything on it is about *that employee*: their next meeting, their upcoming reservations, their notifications, their pending requests. Its portlet grid is a core-platform feature and every module contributes to it. Nothing on it is a business report.

**The sales dashboards are a destination.** They show Shopify data about the business — revenue, orders, sessions, conversion, product performance. They are not personal, they are not for everyone, and they are composed by an administrator rather than assembled from module defaults.

The draft's generic *dashboards → widgets → per-user assignment* model is a genuinely good idea, and it is retained in full. But it belongs to the sales destination, not to the home screen. Concretely: the Sales Dashboard module contributes a small number of **personal** portlets to the home screen (which dashboards *you* have been given, alerts addressed to *you*, and — for those who hold the permission — a compact store-pulse strip), while the composable business dashboards live behind `/sales/…` as ordinary module pages. Section 3 sets this out precisely.

### 1.2 What this module delivers

Employees who are granted access can open one or more sales dashboards, each a grid of widgets showing live Shopify data for the Worood store, updating without a page reload. An administrator can create a new dashboard, choose which widgets it contains and in what order, and assign it to roles or to named individuals — including hybrid views that mix sales and marketing widgets — without a code change or a deployment. The underlying data stays current through webhooks, is corrected continuously by a reconciliation job, and reconciles to the figures Worood's finance team sees in the Shopify admin.

### 1.3 Status of this document

Module 1's design document describes a system that was built and tested end to end; its verification section reports an actual test run. **This document is a design, not a report on a completed build.** Section 13 is therefore a test plan rather than test results, and it is written to the same standard so that "done" is unambiguous when the module is built.

---

## 2. Review of the submitted architecture

The table below is the complete list of changes from the submitted draft. Everything not listed carries over unchanged.

### 2.1 Absorbed into the core platform

| Draft section | Disposition |
|---|---|
| §5 Auth design (self-contained login, Redis sessions, argon2id, lockout, CSRF) | **Removed.** WOROOD HUB already authenticates every employee once, at the platform level: JWT access token with a rotating single-use refresh token, bcrypt at cost 12, five-failure lockout, audit logging. A second login for the sales dashboard would be a regression, not a feature. The draft's CSRF protection falls away for a structural reason worth recording: the platform holds its access token in memory and sends it as an `Authorization` header rather than as a cookie, so there is no ambient credential for a cross-site request to forge. That property must be preserved if single sign-on is added later and tempts anyone toward cookie-based sessions. |
| §3 `users`, `roles`, `user_roles` tables | **Removed.** `core_users`, `core_roles`, `core_user_roles` already exist and are the single source of truth for who works at Worood. |
| `users.is_admin` boolean | **Removed.** WOROOD HUB enforces at the *permission* level, not the role level: routes declare permission keys and roles are bundles of keys. "Administrator" is the `admin` role holding every key, not a column. |
| `users.department_id` | **Removed.** `core_users` already carries department, against the `core_departments` tree. |
| §4 Access resolution "if `is_admin`, return everything" | **Rewritten** as permission-plus-assignment resolution — §7.2. |
| §5 "No public signup — an admin creates each account, and the user sets their own password on first login" | **Deferred to the core platform.** Account creation is already a core-platform responsibility and is not this module's to define. Worth flagging separately: Module 1's API surface has `POST /auth/change-password` but no first-login password-set flow, so the draft's requirement is not currently met anywhere. It should be raised as a core platform item, not built inside a sales module. |
| Real-time "Socket.IO **or** Server-Sent Events" | **Decided: Socket.IO.** SSE is one-directional, and this design needs the client to subscribe and unsubscribe from per-dashboard rooms with a permission check on each subscribe (§8.2). SSE would push that routing to the server as a per-connection filter and would still need a second channel for the subscribe. |
| Backend "Express/Fastify **or** NestJS" | **Decided: NestJS 10.** Not a preference; the module contract in Module 1 §3.3 is built on Nest's module system and guards. |
| ORM "Prisma **or** Drizzle" | **Decided: Drizzle.** Consistency with Module 1, and the same reason it was chosen there — hand-written SQL migrations, no code-generation step, small memory footprint. |
| Frontend "React/**Next.js**" | **Decided: React + Vite.** The portal is an authenticated internal app; server-side rendering buys nothing here. This also answers the draft's own open question. |
| §6 Open question: hosting environment | **Answered.** Ubuntu Server 24.04 LTS on AWS EC2, nginx terminating TLS, systemd supervision. See §12. |

### 2.2 Factual corrections

Each of these was verified against Shopify's official developer documentation and, where possible, against the live Worood store in August 2026. Where a claim could not be verified it is flagged as such rather than asserted.

Two premises underneath the rows below have since been confirmed by Worood and are treated as settled throughout this document: the store is on the **Advanced plan**, and a **new app will be created** rather than an existing one reused. Section 4.9 covers what the second decision implies.

| Draft claim | Finding |
|---|---|
| "Querying customer PII requires requesting protected customer data access for your app… start this early in Shopify's review process." | **Wrong for Worood's situation, and the correction removes a blocking dependency.** App review applies to apps distributed through the Shopify App Store. A custom app — whether an existing admin-created one or a new Dev Dashboard custom-distribution app — is never submitted for review. Level 1 protected customer data is always available, and Level 2 (name, address, phone, email) is always available to a custom app without review. The plan-dependent variant of Level 2 applies only to *admin-created* custom apps, which is not the path Worood is taking, so it does not apply here at all — see §4.9. The access exists as soon as the app is installed. **The compliance obligations still apply in full** — see §4.10. |
| ShopifyQL is "available on your Advanced plan". | **True in effect, wrong in reasoning, and the reasoning is what matters for the build.** Shopify documents no plan requirement on the `shopifyqlQuery` field itself. What it does require is the `read_reports` and `read_customers` scopes and Level 2 customer-data access — so the thing to get right is the app's scopes and distribution method, not the plan. Worood's Advanced plan and custom-distribution app both satisfy it. |
| Sessions and conversion rate are "not exposed via webhooks or standard Admin API objects". | **False, and this is the most consequential correction.** `FROM sessions SHOW sessions, online_store_visitors, sessions_that_completed_checkout, conversion_rate` returns live data through `shopifyqlQuery`, with dimensions for device, country, referrer, landing page and — importantly — `human_or_bot_session`. There is no need for a workaround. |
| Implicit assumption that `shopifyqlQuery` might be deprecated. | **It is not.** Present and not deprecated in API version 2026-07, and expanded since: ShopifyQL now has its own versioned API surface. |
| "Register these webhooks" (topic list). | **Correct list, but incomplete design.** The draft omits the five-second response deadline, the deduplication header, the explicit absence of an ordering guarantee, the automatic deletion of a subscription after eight consecutive failures, and the pinning of payload serialisation to the API version used at registration. Each of these is a production failure waiting to happen; all are handled in §4.3. |
| "Rate limits — GraphQL uses cost-based limiting… build retry/backoff." | **Correct but under-specified.** Worood's Advanced plan restores **200 points per second**; a single query may not exceed **1,000 points**; bulk operations are exempt from both. Bucket capacity is not published by Shopify and must be read at runtime from `throttleStatus`. §4.8. |
| Custom app model assumed to be "Settings → Apps → Develop apps". | **No longer possible.** New custom apps can no longer be created in the Shopify admin; existing ones keep working. New apps are created in the **Dev Dashboard** (which has replaced the Partner Dashboard). This materially changes credential handling — see §4.9, including the fact that a client-credentials token expires every 24 hours. |

### 2.3 Material gaps in the draft, now filled

The draft said nothing about any of the following, and each is load-bearing:

- **The 60-day order window.** By default only the last 60 days of orders are reachable through the `Order` object. A historical or year-on-year view built by iterating orders returns nothing beyond that and fails silently. §4.2.
- **What "sales" means.** The draft never defines the figure the dashboard displays. Shopify's admin reports have precise formulas for gross, net and total sales, and a dashboard that invents its own will not match them — which destroys trust in the dashboard the first time someone checks. §5.
- **Money and currency.** `MoneyBag`, shop currency versus presentment currency, and which of the eight or so total-price fields is correct. Using `totalPriceSet` for revenue — the obvious choice — overstates it by the entire refund volume. §5.2.
- **Timezone.** ShopifyQL aggregates days in the shop's timezone (Africa/Cairo) but emits hourly buckets in UTC. Comparing the two without normalising produces a silent and, on a partial current day, roughly twofold discrepancy. §5.5.
- **Cash on delivery.** Worood's orders sit in a `PENDING` financial status; net payment is zero until collection. A revenue metric defined as "money received" would report near-zero sales. §5.4.
- **Idempotency and ordering of webhook processing.** §4.3–4.4.
- **What Redis is actually for.** The draft names it for pub/sub alone, which would not justify the infrastructure. §8.1.

### 2.4 Retained from the draft

The good ideas in the draft, kept and strengthened: webhooks as the fast path with scheduled reconciliation as the source of truth; ShopifyQL snapshotted into PostgreSQL on a schedule rather than queried live per page view; the generic dashboards-widgets-assignment model, so that a combined view is a data change and not a code change; per-user overrides layered on role defaults; authorisation resolved fresh on every request rather than baked into a token; and Redis with WebSocket for live updates, which per Worood's decision is built now rather than deferred (§8).

---

## 3. Where the module sits

### 3.1 Two surfaces, one platform

```
  ┌──────────────────────────────────────────────────────────────┐
  │  WOROOD HUB HOME  ( / )            PERSONAL — about you      │
  │                                                              │
  │  [ My Next Meeting ] [ Free Right Now ] [ Upcoming ]         │
  │  [ My Sales Dashboards ▸ ] [ Store Pulse ] [ My Alerts ]     │
  │           all three shown only to holders of                 │
  │           sales.dashboard.view                               │
  └──────────────────────────┬───────────────────────────────────┘
                             │  click through
  ┌──────────────────────────▼───────────────────────────────────┐
  │  SALES  ( /sales/d/:key )          BUSINESS — about the shop │
  │                                                              │
  │  Dashboard: "Executive Daily"        [live ●]                │
  │  ┌────────┬────────┬────────┬────────┐                       │
  │  │ Sales  │ Orders │ AOV    │ Conv.  │   ← KPI widgets       │
  │  ├────────┴────────┼────────┴────────┤                       │
  │  │ Sales trend     │ Top products    │   ← chart widgets     │
  │  ├─────────────────┼─────────────────┤                       │
  │  │ Traffic sources │ Recent orders   │                       │
  │  └─────────────────┴─────────────────┘                       │
  │                                                              │
  │  Composed by an administrator. Assigned per role and per     │
  │  individual. A "combined" dashboard is just another row.     │
  └──────────────────────────────────────────────────────────────┘
```

### 3.2 The home-screen portlets are personal

Three portlets, all gated on `sales.dashboard.view`, so an employee with no sales access sees none of them and the home screen is exactly as it is today:

**`my-dashboards`** — the sales dashboards this employee has been assigned, each with its headline figure and the age of its data. This is the module's primary entry point, and it is personal in the strictest sense: two employees with the same permission see different lists.

**`store-pulse`** — a compact four-figure strip: orders today, total sales today, sessions today, conversion rate today, each against the same point yesterday. This is the one piece of business content on the home screen, and it is there deliberately: the people who hold the permission want the number without a click. It is small and it contains no customer data.

**`my-alerts`** — sales alerts addressed to this employee, drawn from `core_notifications` and tagged to the sales module: a dashboard newly assigned to them, or a sync failure if they hold `sales.sync.manage`. Threshold-based alerting — "tell me when today's sales pass X" — is a natural follow-on but is not in phase one, because it needs a rules table and a scheduler of its own; it is noted here so it is not mistaken for something this module already does.

Everything else — every chart, every table, every drill-down — lives under `/sales/…`.

### 3.3 The module descriptor

Per the module contract (Module 1 §3.3), the platform derives navigation, the portlet grid, the permission rows and the `GET /api/v1/hub/modules` response from one declaration:

```ts
export const SALES_DASHBOARD_MODULE = registerHubModule({
  key: 'sales-dashboard',
  name: 'Sales Dashboard',
  nameAr: 'لوحة المبيعات',
  version: '1.0.0',
  apiPrefix: '/api/v1/sales',
  tablePrefix: 'sd_',
  enabled: true,

  navigation: [
    { label: 'Sales',            path: '/sales',              icon: 'trending-up',
      requiresAnyPermission: ['sales.dashboard.view'] },
    { label: 'Orders',           path: '/sales/orders',       icon: 'receipt',
      requiresAnyPermission: ['sales.order.view'] },
    { label: 'Manage Dashboards',path: '/sales/admin',        icon: 'layout-grid',
      requiresAnyPermission: ['sales.dashboard.manage'] },
    { label: 'Data & Sync',      path: '/sales/admin/sync',   icon: 'refresh',
      requiresAnyPermission: ['sales.sync.manage'] },
  ],
  // `requiresAnyPermission` is ANY, not ALL. The four entries are therefore
  // independent: an operations engineer holding only sales.sync.manage sees
  // Data & Sync and nothing else, which is the intended behaviour.

  portlets: [
    { key: 'my-dashboards', title: 'My Sales Dashboards', width: 4, order: 20,
      requiresAnyPermission: ['sales.dashboard.view'] },
    { key: 'store-pulse',   title: 'Store Pulse',         width: 8, order: 25,
      requiresAnyPermission: ['sales.dashboard.view'] },
    { key: 'my-alerts',     title: 'My Sales Alerts',     width: 4, order: 60,
      requiresAnyPermission: ['sales.dashboard.view'] },
  ],

  permissions: [
    { key: 'sales.dashboard.view',   description: 'Open sales dashboards assigned to me' },
    { key: 'sales.dashboard.manage', description: 'Create, edit and delete dashboards; see all of them' },
    { key: 'sales.dashboard.assign', description: 'Assign dashboards to roles and to individuals' },
    { key: 'sales.order.view',       description: 'Browse individual orders (no customer identity)' },
    { key: 'sales.customer.view',    description: 'See customer name, e-mail, phone and address' },
    { key: 'sales.sync.manage',      description: 'Trigger backfills, inspect sync health, re-register webhooks' },
  ],
});
```

Two lines in the application root module register it, and nothing in the meeting-rooms module is edited.

**One small core-platform extension is required, and it should be acknowledged rather than glossed over.** Module 1's descriptor filters *navigation* by permission but not *portlets* — its three portlets are declared without any permission field, because every employee may see their own next meeting. The sales portlets are different: they must be invisible to employees with no sales access. The core module registry therefore gains support for `requiresAnyPermission` on a portlet entry, filtered in the same place and the same way it already filters navigation. This is a handful of lines in the core, it is a capability every future module will want, and it is the only change to shared code this module needs. It should be built as a core change with its own test, not smuggled in as part of the sales module.

In the existing home-screen prototype the work is correspondingly small but is not a flag flip, because the Sales Dashboard has no `comingSoon` entry to promote — that list holds Leave Requests, Help Desk and Document Library. Concretely: a new enabled Sales Dashboard descriptor is added to `src/lib/api/mockHub.ts` along with the three portlet payloads; three portlet components are added under `src/components/portlets/`; and the portlet key-to-component map that `src/pages/Dashboard.tsx` renders from gains three entries.

### 3.4 On `sales.customer.view`

Separating "see orders" from "see who the customer is" is not bureaucratic tidiness. Level 2 protected customer data carries an obligation to limit staff access to it and to keep an access log, and a permission boundary is how that obligation is discharged in code. A merchandiser looking at product performance has no need for a customer's phone number; a customer-service supervisor does. §7.4 covers how the boundary is enforced at the field level rather than only at the route.

---

## 4. Data flow and synchronisation

### 4.1 Two sources, and a rule for choosing between them

Shopify exposes the same underlying commerce through two very different doors, and most of the reliability of this module comes from using each for what it is good at.

**ShopifyQL, through `shopifyqlQuery`, is the analytics door.** It returns pre-aggregated metrics that match the Shopify admin's own reports, reaches back years, and is not subject to the sixty-day order window. It is the right source for every aggregate: sales, orders, average order value, sessions, conversion, product and channel breakdowns.

**The GraphQL Admin API's `Order`, `Refund` and `Customer` objects are the record door.** They return individual entities with full detail, and they are the right source for anything an employee needs to look at one row at a time.

The rule, stated once and applied everywhere:

> **Aggregates come from ShopifyQL. Individual records come from the Admin API objects. A dashboard figure is never computed by summing mirrored order rows when a ShopifyQL metric exists for it.**

This rule is what makes the dashboard reconcile with the Shopify admin. Recomputing "total sales" from mirrored orders means reimplementing Shopify's own formula, including its treatment of edits, partial refunds, duties, and test orders — and being wrong in a way nobody can explain. The mirror exists to power order-level views, drill-downs and joins against Worood's own data; it is not the arithmetic basis of the headline numbers.

### 4.2 The sixty-day window

Shopify's own documentation is explicit: *only the last 60 days' worth of orders from a store are accessible from the `Order` object by default.* Older records require the `read_all_orders` scope, which Shopify grants against a legitimate need.

This constraint bites in a specific and dangerous way — the query does not error, it simply returns fewer rows. The design accommodates it as follows. The order mirror is treated as a **rolling recent-history store**, not an archive; its retention is a deliberate choice (§4.10) rather than an accident of what the API will return. Every historical, year-on-year and long-range view is served from ShopifyQL, which is unaffected. If Worood later wants order-level detail beyond sixty days, `read_all_orders` is requested and a bulk backfill runs once; nothing about the schema changes.

### 4.3 Webhooks: the fast path

Seven subscriptions, registered through `webhookSubscriptionCreate`. The GraphQL enum names are given because they are not derivable from the topic strings by any consistent rule — note `ORDERS_CREATE` against `ORDERS_UPDATED`.

| Enum | Topic string | Purpose |
|---|---|---|
| `ORDERS_CREATE` | `orders/create` | New order lands |
| `ORDERS_UPDATED` | `orders/updated` | Edit, fulfilment change, financial status change |
| `ORDERS_PAID` | `orders/paid` | Payment captured — the meaningful event on a COD store |
| `ORDERS_CANCELLED` | `orders/cancelled` | Cancellation |
| `REFUNDS_CREATE` | `refunds/create` | Refund recorded, independent of money movement |
| `CUSTOMERS_CREATE` | `customers/create` | New customer |
| `CUSTOMERS_UPDATE` | `customers/update` | Customer detail change |

An eighth, `BULK_OPERATIONS_FINISH` (`bulk_operations/finish`), is registered so backfills complete by notification rather than by polling.

Five properties of Shopify's webhook delivery drive the design of the receiver, and the draft accounted for none of them.

**There is a five-second deadline.** Shopify's documented requirement is that the endpoint responds within five seconds; a shorter budget for establishing the connection is also described in Shopify's delivery guidance, though less prominently, so the safe reading is that five seconds is the whole envelope and not a per-phase allowance. Anything outside 2xx — including a redirect — counts as a failure. The endpoint therefore does the minimum: verify the signature, write the raw event to `sd_webhook_events`, enqueue a job, return 200. Target latency is under 200 milliseconds; no Shopify API call, no aggregation and no business logic happens on that thread.

**Delivery is not guaranteed.** Shopify states plainly that webhooks can be missed. This is the whole justification for §4.5; the draft's instinct here was right.

**Order is not guaranteed.** Within a topic or across topics for the same resource, a later event can arrive first. Every write to a mirrored row is therefore guarded: the update applies only if the payload's `updated_at` is greater than or equal to the stored `shopify_updated_at`, with the `X-Shopify-Triggered-At` header — RFC 3339 with nanosecond precision — as the tiebreak. A stale event is recorded and discarded rather than applied.

**Duplicates happen.** `X-Shopify-Webhook-Id` is unique per delivery and is the deduplication key; it is a unique column on `sd_webhook_events` and the insert is `ON CONFLICT DO NOTHING`, so a duplicate is absorbed at the database rather than reasoned about in code. `X-Shopify-Event-Id` is shared across all deliveries caused by the same merchant action and is stored for correlation only — using it to deduplicate would silently drop legitimate deliveries when more than one subscription covers a topic.

**A failing subscription is deleted.** After eight consecutive failures over about four hours, Shopify automatically deletes a subscription that was created through the Admin API. A deployment window, a bad release or an expired certificate can therefore leave Worood with a dashboard that looks fine and has silently stopped receiving orders. The countermeasure is a **daily subscription watchdog**: a scheduled job queries `webhookSubscriptions`, compares against the module's declared set, re-registers anything missing, and raises a `core_notifications` alert to holders of `sales.sync.manage`. This job is cheap and it is not optional.

Two further details. Signature verification is `base64(HMAC-SHA256(raw_body, client_secret))` compared against the `X-Shopify-Hmac-Sha256` header using a constant-time comparison — and it is the **raw body bytes**, captured before any JSON parsing. In NestJS this means bootstrapping with `rawBody: true` and reading `req.rawBody` in the guard; a body-parser that has already deserialised and re-serialised the payload will produce a signature that never matches. Note also that after rotating the client secret Shopify may take up to an hour to sign with the new value, so the verifier accepts either secret during a rotation window. Separately, a subscription registered through the Admin API is pinned to the API version in the request URL and does not advance on its own; the quarterly version bump (§4.9) therefore includes re-registering the subscriptions and testing the new payload shape with `shopify app webhook trigger` first.

### 4.4 The queue

Every webhook becomes a job on a Redis-backed **BullMQ** queue consumed by a worker process separate from the API process. The separation matters: a burst of orders must never make the portal slow for someone booking a meeting room.

Jobs are idempotent by construction — each is keyed to a `sd_webhook_events` row, and processing it twice produces the same database state, because the ordering guard rejects the second application. Failures retry with exponential backoff, and a job that exhausts its retries moves to a dead-letter queue and raises an alert rather than vanishing. The queue also carries the scheduled work: reconciliation, ShopifyQL snapshots, the subscription watchdog and the retention sweep.

### 4.5 Reconciliation is the source of truth

Every fifteen minutes, a job pulls from the Admin API every order whose `updated_at` falls after the last successful reconciliation watermark, less a five-minute overlap for safety, and upserts it through the same code path the webhook handler uses. Customers follow hourly on the same pattern. The watermark advances only on success, so a failed run re-covers the same ground rather than leaving a hole.

This is the draft's own principle, and it is correct: webhooks make the dashboard feel live, reconciliation makes it true. The fifteen-minute cadence is the practical upper bound on how long a missed webhook can go unnoticed.

### 4.6 Backfill

Initial load and any large historical pull uses `bulkOperationRunQuery`, which is exempt from the calculated-cost rate limits and from the thousand-point ceiling on a single query. The operation is started, `bulk_operations/finish` announces completion, and the resulting JSONL is streamed and upserted in batches. Two details worth encoding rather than rediscovering: the JSONL flattens nested connections, with child rows carrying an added `__parentId` pointing at the parent, so line items are reassembled from that; and the signed result URL expires after seven days, so it is downloaded promptly rather than stored as a reference. In the webhook payload announcing completion, `status` and `error_code` arrive lowercase rather than in the GraphQL enum's upper case.

As of API version 2026-01 a shop may run up to five concurrent bulk query operations per app, so a backfill can be partitioned by date range rather than serialised. `bulkOperation(id:)` is the current way to poll; `currentBulkOperation` is deprecated.

### 4.7 ShopifyQL snapshots

Live ShopifyQL queries per page view would be slow, would consume the rate-limit budget unpredictably, and would make the dashboard's responsiveness a function of Shopify's. Instead a scheduled job captures results into `sd_metric_snapshots`, and widgets read from PostgreSQL.

Two cadences. **Hourly**, the current and previous day at hour grain for the pulse and intraday trend widgets. **Nightly**, day grain for the trailing thirteen months, which refreshes any historical figure Shopify has since adjusted and keeps year-on-year comparisons honest.

The canonical sales capture is a single query, and it is deliberately Shopify's own vocabulary rather than a reinvention:

```sql
FROM sales
SHOW orders, gross_sales, discounts, sales_reversals, net_sales,
     shipping_charges, taxes, total_sales, average_order_value
TIMESERIES day SINCE -395d UNTIL today
WITH TIMEZONE 'Africa/Cairo'
```

and the traffic capture alongside it:

```sql
FROM sessions
SHOW sessions, online_store_visitors, sessions_with_cart_additions,
     sessions_that_reached_checkout, sessions_that_completed_checkout,
     conversion_rate
TIMESERIES day SINCE -395d UNTIL today
WHERE human_or_bot_session = 'human'
WITH TIMEZONE 'Africa/Cairo'
```

Three notes on the second query. Bot filtering is not automatic; omitting the `WHERE` clause inflates sessions and depresses conversion rate. Whichever convention Worood adopts must be applied consistently and stated on the widget, because the two produce visibly different numbers. And `conversion_rate` comes back as a fraction — `0.0119` means 1.19 per cent — despite being typed as a percentage.

Two further mechanics. ShopifyQL reports syntax problems as a populated `parseErrors` array inside an HTTP 200, not as a GraphQL error, so the client checks that array explicitly or failures pass unnoticed. And the most recent bucket is always provisional: the current hour and the current day are incomplete by definition, and analytics figures settle over a short interval. Snapshot rows therefore carry an `is_final` flag, set once the bucket is closed and re-captured, and the interface labels a provisional figure rather than presenting it as settled.

Shopify publishes no freshness guarantee for analytics data. Observation on the Worood store suggests lag well under an hour, with an order appearing inside its own hourly bucket, but that is a measurement rather than a commitment and the design does not depend on it.

### 4.8 Rate limits and the cost governor

The GraphQL Admin API prices each query by calculated cost and refills a bucket at a fixed rate per second. On Worood's Advanced plan the restore rate is **200 points per second**. It is still held in configuration rather than hard-coded, because Standard restores 100 and Plus restores 1,000, and a plan change should be a configuration edit rather than a defect. A single query may not exceed **1,000 points** regardless of plan, and input arrays are capped at 250 items. Bucket capacity is not published by Shopify; every response carries it in `extensions.cost.throttleStatus.maximumAvailable`, and the correct approach — Shopify's own recommendation — is to read it at runtime rather than hard-code an assumption.

Because two processes call Shopify (the API for on-demand refreshes, the worker for scheduled jobs), a per-process limiter would let them collectively exceed the budget. A **shared token bucket in Redis** governs all outbound calls: every response updates it from the returned `throttleStatus`, and a caller needing more points than are currently available waits `(needed − available) / restoreRate` seconds instead of firing and being rejected. On a 429, or on a `THROTTLED` error returned inside a 200, the call backs off — Shopify's documented starting point is one second — and retries with jitter.

This is one of the five jobs that justify Redis (§8.1), and it is the one that is hardest to do correctly without it.

### 4.9 Credentials and the app model

The submitted draft assumes a private app created through *Settings → Apps → Develop apps*. **That path is closed**: new custom apps can no longer be created in the Shopify admin, though existing ones continue to work. Apps are now created in the Dev Dashboard, which has replaced the Partner Dashboard.

**Decided: Worood creates a new app.** It is therefore a Dev Dashboard app, and one property of it must be chosen deliberately rather than accepted by default.

**Choose custom distribution.** An app's distribution method is set once and can never be changed afterwards, so this is the single irreversible decision in the whole module. Custom distribution installs the app on one store by link, requires no Shopify review, and — this is the part that matters — places the app in the "custom app" column of Shopify's protected-customer-data table, where Level 2 access is *always available* rather than plan-dependent. Public distribution would require app review and would put Level 2 behind it. Nothing about this module benefits from public distribution, and choosing it by accident would be expensive to undo.

Two consequences follow, and both are good news relative to the alternative that no longer exists. Level 2 customer data access is no longer tied to the store's plan, so a future plan change cannot revoke it. And the credentials are rotatable from the Dev Dashboard, where an admin-created custom app's token could only be replaced by uninstalling and reinstalling.

#### Obtaining the access token

There are two ways to get a token for a custom-distribution app, and the design should be built to accept either, because which one is available depends on a constraint that has not yet been checked.

**Preferred: the client credentials grant.** A single request, no browser, no redirect, no callback route:

```
POST https://{shop}.myshopify.com/admin/oauth/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=…&client_secret=…
```

The token returned **expires after 24 hours** (`expires_in: 86399`) and is never visible in the Shopify admin. This is the significant operational difference from the draft's assumption of a permanent token, and it is why the module needs a **token manager** as a real component rather than a configuration value: cache the token in Redis with a TTL comfortably short of its expiry, refresh ahead of time on a schedule, refresh on demand if a call returns 401, and take a lock around the refresh so a burst of workers triggers one request rather than twenty. This is written once and every outbound call goes through it.

The grant carries one hard constraint: **the app and the store must belong to the same Shopify organisation**, or it fails with `shop_not_permitted`. Owning the store is not sufficient — it must appear under the Dev Dashboard organisation's stores. **This should be verified in the first hour of work** (§15), because it decides which of the two paths is used.

**Fallback: OAuth install.** If the organisation constraint is not satisfied, the app is installed through its custom-distribution install link, which runs the authorization code grant and yields an offline access token. This costs a one-time install flow and a callback route that exists only for that purpose, and it produces a token with a longer life. It is worth noting that Shopify has been moving offline tokens toward expiry since late 2025, and that the January 2027 mandate for public apps is reported to exempt custom apps — but the token manager makes this immaterial, because a long-lived token is simply one that refreshes rarely. **Build the token manager either way**; do not shortcut it on the assumption that the token is permanent.

In both cases the **client secret is the webhook HMAC key**, and it is not the access token. Confusing the two produces a signature that never verifies, and the error message does not point at the cause.

Requested scopes: `read_orders`, `read_customers`, `read_products`, `read_reports`, and `read_all_orders` only if Worood decides it needs order-level history beyond sixty days.

The API version is pinned in configuration, not scattered through the code. Today that is **2026-07**, which Shopify supports until 16 July 2027. Versions ship quarterly and are supported for at least twelve months, so the standing operational task is one version bump per quarter, exercised on staging, including re-registration of webhook subscriptions. The REST Admin API has been legacy since October 2024 and is in maintenance mode; nothing in this module uses it, although webhook payload bodies still arrive in the REST resource shape, which is a separate matter.

### 4.10 Protected customer data

The draft treated Shopify approval as a schedule risk. It is not one — no review process applies here. What does apply is a set of obligations that hold regardless, and they translate into concrete engineering work.

Level 1 requires processing only the minimum personal data needed, applying retention periods so data is not kept longer than necessary, and encrypting data in transit and at rest. Level 2 — which Worood is in, because names, addresses, phones and e-mails are in scope, and because ShopifyQL itself requires Level 2 — adds encrypted backups, separation of test and production data, limited staff access, and **an access log for protected customer data**.

The design discharges these as follows. Storage is minimised: the mirror keeps the customer's Shopify identifier, order counts and lifetime value unconditionally, while name, e-mail, phone and address are stored only because order-level views need them and are held in a dedicated column set that can be nulled by a single retention job. Raw webhook payloads, which contain full PII, are trimmed to metadata after thirty days. Access is logged: every read of a customer-identifying field writes to `core_audit_logs` with the actor, the customer identifier and the source IP — reusing the platform's existing append-only log rather than inventing a second one. Encryption at rest is EBS volume encryption plus encrypted snapshots and server-side encryption on the S3 backup bucket. Staff access is limited by `sales.customer.view`.

Shopify sets no maximum retention period; the obligation is purpose-bound. **Worood must therefore choose a retention period and record it as policy** — it is a decision, not a default, and it is listed in §14. Note also that Shopify's data protection reviews specifically target apps with long retention, which is a further argument for choosing a short one.

One risk that would have applied does not, and it is worth recording why so that nobody reintroduces it. For an *admin-created* custom app, Level 2 access is tied to the store's plan and a downgrade revokes it — which would silently break every customer-facing view in the dashboard. Because Worood is creating a new custom-distribution app instead (§4.9), Level 2 is unconditional and no plan change can take it away.

---

## 5. Money, time, and the definition of "sales"

This section exists because a sales dashboard that disagrees with the Shopify admin is worse than no dashboard. The first time a manager checks a figure and finds it wrong, every other figure becomes suspect.

### 5.1 Money is a pair, not a number

The Admin API returns money as a `MoneyBag` with two members: `shopMoney`, denominated in the store's base currency, and `presentmentMoney`, in the currency the customer saw. **All aggregation uses `shopMoney`** — summing presentment amounts adds unlike currencies and is simply wrong. Presentment amounts are stored alongside, because an order detail view and any payment dispute need the figure the customer actually saw.

Amounts arrive as strings and are stored as `numeric`, never as floating point. Worood's store is denominated in EGP and formats without decimal places, but that is a presentation convention; storage keeps full precision.

### 5.2 Which total is the total

There are more than a dozen price fields on an order, and the distinction that governs them is simple once stated: **`total*` and `subtotal*` are values before returns; `current*` are values after returns, refunds, edits and cancellations.**

| Field | Meaning |
|---|---|
| `totalPriceSet` | Total including taxes and discounts, **before returns** |
| `currentTotalPriceSet` | Total including taxes and discounts, **after returns** |
| `subtotalPriceSet` | Line items after discounts, before returns |
| `netPaymentSet` | Total received minus total refunded |
| `totalRefundedSet` | Amount refunded |
| `totalOutstandingSet` | Not yet transacted; positive favours the merchant |

The trap: `totalPriceSet` is the obvious field and the wrong default for revenue, because it ignores every refund and return. A dashboard built on it overstates revenue by exactly the refund volume — a figure that is invisible until someone reconciles.

### 5.3 Shopify's formulas, used verbatim

For any headline figure the dashboard uses Shopify's own definitions, captured from ShopifyQL rather than recomputed:

```
gross_sales      top-line revenue before discounts and returns
                 (excludes taxes, shipping, duties, fees)
discounts        amount removed through discounts
sales_reversals  value removed through refunds, returns, cancellations or edits

net_sales        = gross_sales − discounts − sales_reversals
total_sales      = net_sales + additional_fees + duties + shipping_charges + taxes

orders           each order counted once, regardless of item count
average_order_value = (gross_sales − discounts) / orders
```

Note that average order value is computed *before* `sales_reversals`. A dashboard that divides `total_sales` by `orders` will not match the Shopify admin, and the difference will be small enough to look like a rounding bug and large enough to matter.

Order-level fields remain the right tool for order-level questions: `netPaymentSet` for what has actually been collected on a given order, `currentTotalPriceSet` for what an order is worth after returns.

Two exclusions apply to anything computed from the mirror rather than from ShopifyQL. Test orders are flagged by `test: true` and are excluded from every aggregate. Cancelled orders are identified by a non-null `cancelledAt` with a `cancelReason`, and are excluded or shown separately depending on the widget. Whether ShopifyQL's `sales` schema itself excludes test orders is not documented; this should be established empirically during the build and the answer recorded, because it determines whether a mirror-derived figure and a ShopifyQL figure are expected to agree exactly.

### 5.4 Cash on delivery changes the honest headline

Worood's orders sit in a `PENDING` financial status, which is what a cash-on-delivery flow looks like: the order exists and the money has not moved. On such a store `netPaymentSet` is zero for most live orders, and a revenue metric defined as "money received" would report a near-empty dashboard on a busy day.

The design consequence is that the dashboard must show **two distinct figures and label them**: *sales* — what has been ordered, per Shopify's `total_sales` — and *collected* — what has actually been received, from `netPaymentSet`. The gap between them is not an error; on a COD business it is the single most operationally interesting number on the screen, because it is the money in transit with the couriers. A dashboard that shows only one of the two is misleading whichever one it picks.

### 5.5 The timezone trap

ShopifyQL aggregates day-grain series in the shop's timezone by default — for Worood, `Africa/Cairo`, currently UTC+3 — while hour-grain series are emitted with UTC timestamps. The two are therefore offset by three hours, and on a partial current day the difference is not subtle: a day-grain query and a sum of hour-grain buckets for "today" can differ by roughly a factor of two, because the Cairo day began at 21:00 UTC the previous evening.

Three rules follow. Every ShopifyQL query passes `WITH TIMEZONE 'Africa/Cairo'` explicitly rather than relying on a default that is not documented in prose. Every snapshot row stores the timezone it was aggregated in, so a later reader cannot misinterpret it. And hour-grain series are normalised to the shop timezone at ingestion, so no widget ever mixes a UTC hour with a Cairo day.

This is consistent with Module 1's handling of time — `timestamptz` in UTC everywhere, interpreted against a site's IANA timezone at query time. The shop's timezone is read once from `shop.ianaTimezone` and stored on `sd_shops` rather than hard-coded, because a store's timezone is a setting and Egypt observes daylight saving.

---

## 6. Database structure

### 6.1 Conventions

Inherited unchanged from Module 1 §4.1: `sd_` prefix on every table, UUID primary keys from `gen_random_uuid()`, `timestamptz` in UTC throughout, `updated_at` maintained by trigger, soft deletion for anything that carries history. Shopify's own identifiers are stored as the full GID string (`gid://shopify/Order/…`) in a unique column, so the mirror can be rebuilt from scratch without identity drift.

### 6.2 Shopify mirror

| Table | Purpose |
|---|---|
| `sd_shops` | One row per connected store: myshopify domain, display name, `iana_timezone`, base currency, plan, pinned API version, watermarks. Modelled as a table rather than configuration so a second Worood store is a row, not a migration. |
| `sd_webhook_events` | Every delivery: `webhook_id` (unique — the dedup key), `event_id`, topic, `triggered_at`, API version, raw payload, receipt and processing timestamps, attempt count, status, error. Payloads trimmed to metadata after the retention window. |
| `sd_orders` | Order mirror: Shopify GID, order name and number, created/processed/updated/cancelled timestamps, `cancel_reason`, `test`, financial and fulfilment status, both currency codes, the shop-currency money columns of §5.2 with their presentment counterparts, source and referrer, customer reference, and `shopify_updated_at` — the column the ordering guard compares against. |
| `sd_order_line_items` | Line items with product and variant GIDs, title, SKU, ordered and current quantity, and discounted totals. |
| `sd_refunds` | Refunds against orders, with amounts and timestamps. |
| `sd_customers` | Customer mirror. Non-identifying columns (GID, order count, lifetime value in shop currency, state, first and last order dates) unconditionally; identifying columns (name, e-mail, phone, address) in a separate, nullable column group governed by the retention job. |
| `sd_products` | Product and variant catalogue, for joins and drill-downs. Optional for phase one — product performance widgets are served from ShopifyQL. |
| `sd_sync_state` | Per shop and resource: last watermark, last run, outcome, error. What the Data & Sync screen reads. |

### 6.3 Snapshots

```sql
sd_metric_snapshots (
  id, shop_id,
  schema,            -- 'sales' | 'sessions' | 'inventory' | …
  grain,             -- 'hour' | 'day'
  bucket_start,      -- timestamptz, normalised
  bucket_timezone,   -- the IANA zone the bucket was aggregated in
  dimensions,        -- jsonb: {} for totals, {"product_title": "…"} for breakdowns
  dimensions_hash,   -- generated column, for the unique index
  metrics,           -- jsonb: {"total_sales": 70526.00, "orders": 35, …}
  captured_at,
  is_final,          -- false while the bucket is still open
  UNIQUE (shop_id, schema, grain, bucket_start, dimensions_hash)
)
```

JSONB for metrics rather than a column per figure, because ShopifyQL's schemas evolve and a new metric should not require a migration — the same reasoning that put module settings in JSONB in the core platform. The unique key makes re-capture an idempotent upsert, which is what allows the nightly job to correct thirteen months of history without duplicating anything.

### 6.4 Dashboard composition

This is the draft's model, kept intact and moved under the module prefix:

```sql
sd_dashboards        (id, key, name, name_ar, description, is_system, created_by, …)
sd_widgets           (id, key, name, name_ar, data_source, default_config,
                      required_permission, min_width, max_width)
sd_dashboard_widgets (dashboard_id, widget_id, position, width, config_override)

sd_role_dashboard_access (role_id, dashboard_id)              -- default by role
sd_user_dashboard_access (user_id, dashboard_id, effect)      -- 'GRANT' | 'REVOKE'
```

`role_id` and `user_id` are foreign keys into `core_roles` and `core_users`. This is the only place the module holds a foreign key into a core table, and it is acceptable because the reference is read-only and by key. The module does write to `core_audit_logs` and `core_notifications` elsewhere, but always through the core's own services, never by direct SQL — which is precisely the rule Module 1 §3.2 sets out and the reason modules stay removable.

The draft's central observation holds and is worth repeating: **a combined dashboard needs no special-casing.** An administrator building a hybrid Sales-and-Marketing view creates a row in `sd_dashboards` and picks existing widgets into it. There is no code path for "combined" because there is no such thing.

One rename and two additions to the draft's model. The draft's `widgets.config_json` becomes `sd_widgets.default_config`, with the per-placement override moving to `sd_dashboard_widgets.config_override` — the same data, but it is now obvious which of the two a given value came from. `sd_widgets.required_permission` lets a widget carry its own permission — an order-list widget requiring `sales.order.view` is invisible on a dashboard shown to someone who lacks it, rather than the whole dashboard being withheld. And `effect` on the per-user table makes revocation explicit, so an individual can be removed from a dashboard their role otherwise grants, which the draft's model could express only by changing the role.

### 6.5 Indexing

Beyond primary keys and unique constraints: `(shop_id, created_at DESC)` and `(shop_id, shopify_updated_at)` on orders, for the recent-orders view and for reconciliation respectively; `(customer_id, created_at DESC)` for customer order history; `(order_id)` on line items and refunds; `(shop_id, schema, grain, bucket_start DESC)` on snapshots, which serves nearly every widget read; a partial index on `sd_webhook_events (status)` restricted to unprocessed rows, which stays small because the table is swept; and a GIN index on `sd_metric_snapshots.dimensions` for breakdown queries. At Worood's volumes — on the order of tens of thousands of orders and a few hundred thousand snapshot rows per year — this is comfortable.

### 6.6 Migrations

One new numbered file, `0003_sales_dashboard.sql`, applied by the existing checksum-verified runner in `ExecStartPre`. Nothing in `0001_core_platform.sql` or `0002_meeting_rooms.sql` is edited; the runner would refuse to start if it were.

---

## 7. Access model

### 7.1 No new authentication

The employee has already signed in to WOROOD HUB. The sales module adds no login, no session store and no password handling. Requests pass through the platform's existing chain: throttler, JWT guard attaching the principal with roles and permissions, permissions guard checking the route's declared keys, validation pipe, controller, service, Drizzle. The draft's argon2id proposal is set aside in favour of the platform's bcrypt at cost 12 — not because argon2id is worse, but because two password hashing schemes in one system is a liability with no offsetting benefit.

### 7.2 Resolution

This resolves **which dashboards an employee gets**. It is not the module's whole authorisation story: the other routes carry their own permission keys independently, so an operations engineer holding only `sales.sync.manage` reaches the Data & Sync screen without holding `sales.dashboard.view` at all.

1. Without `sales.dashboard.view`, no dashboards are returned and the three home-screen portlets are not rendered. The resolution stops here.
2. With `sales.dashboard.manage`, every dashboard is returned. Administrators are identified by permission, not by a column.
3. Otherwise the effective set is the union of the dashboards granted to the employee's roles through `sd_role_dashboard_access`, plus individual `GRANT` rows, minus individual `REVOKE` rows.
4. Within a resolved dashboard, any widget whose `required_permission` the employee lacks is dropped from the layout before it is returned. The frontend never receives a widget it may not see, so a widget cannot be revealed by manipulating the client.

### 7.3 Why authorisation is not carried in the token

The draft argued that access must not be baked into the session, so that assigning or unassigning a dashboard takes effect immediately. The reasoning is sound and it survives, with one adjustment for how WOROOD HUB actually works. The platform's access token is short-lived — fifteen minutes — and carries roles and permissions. Dashboard *assignment* is finer-grained than that and changes more often, so it is resolved from PostgreSQL on every request that returns dashboards or widget data, never cached in the token and never cached in Redis beyond the lifetime of a single request. Unassignment is therefore effective on the next request, with no logout and no token blocklist.

### 7.4 Customer data at the field level

`sales.customer.view` is enforced in the serialisation layer, not only on the route. An order returned to an employee without the permission has its customer name, e-mail, phone and address omitted from the response — not blanked in the browser. Where the permission is present and identifying fields are actually returned, the response path writes an entry to `core_audit_logs`. This is what satisfies the Level 2 access-log obligation, and doing it in one place is why it will still be true in a year.

### 7.5 Suggested role mapping

Indicative, for Worood to confirm: `employee` gets nothing from this module; a `sales-viewer` role gets `sales.dashboard.view`; `sales-manager` adds `sales.order.view` and `sales.customer.view`; `sales-admin` adds `sales.dashboard.manage` and `sales.dashboard.assign`; the existing `admin` role holds every key, as it already does by definition. Because permissions are data, this mapping is changed in the admin screen rather than in a deployment.

---

## 8. Real-time layer

### 8.1 What Redis is for

Worood's decision is to build the Redis and WebSocket layer now rather than defer it. That decision is sound, but it deserves a stronger justification than the draft gave it — pub/sub alone would not pay for the infrastructure. Redis does five jobs here, and at least three of them have no good alternative:

**Job queue.** BullMQ backs webhook processing, reconciliation, snapshots, backfill, the subscription watchdog and the retention sweep, with retries, backoff, scheduling and a dead-letter queue. Building this on PostgreSQL is possible and is a meaningful amount of code to write and then maintain.

**Cross-process fan-out.** The API and the worker are separate processes. A change detected by the worker must reach sockets held by the API, and that is a genuine inter-process channel even on a single instance — the draft's stated use, and it is real, just not sufficient on its own.

**The Shopify cost governor.** A shared token bucket, so the API and the worker cannot collectively exceed 200 points per second (§4.8). This is the job that most clearly needs shared mutable state with atomic operations.

**Widget result cache with stampede protection.** Short-TTL caching of computed widget payloads, with a lock so that ten people opening the same dashboard at nine in the morning produce one query rather than ten.

**Access-token cache.** If Worood ends up on the client credentials grant, the 24-hour token lives in Redis with a serialised refresh (§4.9).

That is a layer that earns its place, and it also removes the awkwardness of the original position where Redis appeared for one purpose and had to be justified against a design document that explicitly deferred it.

### 8.2 Socket.IO design

One namespace, `/sales`. The handshake carries the platform access token; the connection is rejected outright if the token is invalid or the principal lacks `sales.dashboard.view`. A client then subscribes to rooms named for the dashboards it has open — `dash:{dashboard_id}` — and **the subscribe handler re-runs the resolution of §7.2 before joining**, because a socket outlives a request and a dashboard can be unassigned mid-session. Assignment changes emit a `dashboard:revoked` event and force the client out of the room.

The Redis adapter (`@socket.io/redis-adapter`) is wired from the outset even though there is a single instance. It costs nothing now and it is the difference between a straightforward move to two instances behind a load balancer and a rewrite.

**Events carry invalidation signals, not data.** When an order lands, the server emits `metrics:changed` with the affected widget keys and a bucket timestamp; the client invalidates the corresponding TanStack Query keys and refetches through the ordinary authenticated API. This is a deliberate choice with three benefits: no data path bypasses the permissions layer, so a socket can never leak a figure the employee may not see; no customer data ever travels over a socket; and the client's caching, retry and error handling stay in one place. Order-level events are emitted at a coarse grain — "orders changed" rather than the order itself — for the same reason.

Fallback and reconnection: Socket.IO negotiates long-polling where WebSocket upgrade is blocked, and on reconnect the client refetches everything visible rather than trusting that it missed nothing. A dashboard whose socket has been down for more than a few seconds shows a subdued "reconnecting" state rather than presenting stale figures as live.

### 8.3 nginx

The existing site configuration gains an upgrade-aware location:

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 7d;
    proxy_send_timeout 7d;
}

location /api/v1/sales/webhooks/shopify {
    proxy_pass http://127.0.0.1:3000;
    proxy_request_buffering off;
    proxy_read_timeout 10s;
    limit_req zone=shopify_webhooks burst=200 nodelay;
}
```

The webhook location is separated so its rate limit can be generous — a flash sale is a legitimate burst — without loosening the limits protecting the login endpoint. Its timeout is short because a slow response there costs a subscription (§4.3).

---

## 9. API surface

All routes under `/api/v1/sales`, versioned in the path as the platform requires, documented through the existing OpenAPI generation.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dashboards` | Dashboards resolved for the caller |
| `GET` | `/dashboards/:key` | Layout with widgets, permission-filtered |
| `GET` | `/dashboards/:key/data` | All widget payloads for one dashboard, in one round trip |
| `GET` | `/widgets/:key/data` | One widget's payload; accepts range and dimension parameters |
| `GET` | `/pulse` | The home-screen store-pulse figures |
| `GET` | `/orders` | Order list with filters; customer fields omitted without permission |
| `GET` | `/orders/:id` | Order detail with line items and refunds |
| `GET` | `/metrics/series` | Time series for a metric set, grain and range |
| `POST` | `/dashboards` | Create a dashboard (`sales.dashboard.manage`) |
| `PATCH` | `/dashboards/:id` | Rename, re-describe, reorder widgets |
| `PUT` | `/dashboards/:id/widgets` | Replace the widget layout |
| `DELETE` | `/dashboards/:id` | Retire a dashboard — soft delete |
| `GET` | `/widgets` | Widget catalogue for the composer |
| `PUT` | `/dashboards/:id/access` | Set role and per-user assignment (`sales.dashboard.assign`) |
| `GET` | `/admin/sync` | Sync health: watermarks, last runs, queue depth, dead letters |
| `POST` | `/admin/sync/backfill` | Start a bulk backfill for a date range |
| `POST` | `/admin/sync/webhooks/verify` | Run the subscription watchdog on demand |
| `POST` | `/webhooks/shopify` | Shopify delivery endpoint — HMAC guard, no JWT, not in OpenAPI |

The webhook endpoint is the one route in the module that is not authenticated by the platform's JWT guard, because Shopify does not carry one. It is authenticated by HMAC instead, and it is excluded from the global guard explicitly and visibly rather than by a path pattern that a future refactor might quietly widen.

---

## 10. Frontend

The sales screens are ordinary routed React components inside the existing Vite application, using the existing stylesheet of design tokens. No UI framework is introduced.

**The widget registry** maps a widget key to a component, mirroring how the shell already maps portlet keys. A dashboard renders by walking its layout and looking each key up; an unknown key renders a placeholder rather than breaking the grid, so a server that has been deployed ahead of the client degrades gracefully.

**The composer**, on `/sales/admin`, is a two-pane screen: the widget catalogue on one side, the dashboard's grid on the other, drag to add and reorder, width per widget, save. Assignment is a separate tab with role checkboxes and an employee picker reusing the directory search built for the meeting-room attendee picker.

**Data flow.** TanStack Query owns server state, as it already does. Each widget is a query keyed by widget key plus parameters. The socket layer dispatches invalidations into the same cache, so a live update and a manual refresh follow identical code paths — which means the live path cannot develop bugs the manual path does not have.

**Charts.** A small charting library rather than a dashboard framework, wrapped so that every chart in the module shares one set of colours, one date-axis treatment and one empty state. Figures are formatted in EGP following the store's own convention of no decimal places; percentages are multiplied out of the fractions ShopifyQL returns; a provisional bucket is visually distinguished from a settled one.

**Arabic and RTL.** Widget and dashboard names carry `name_ar` alongside `name`, matching the pattern in the meeting-rooms schema, and the stylesheet's logical properties mean the grid mirrors correctly under `dir="rtl"`. Chart axis direction and number formatting are handled in the chart wrapper so it is done once.

---

## 11. Security additions

Everything in Module 1 §6 applies unchanged. This module adds five things.

**Shopify credentials.** Only two long-lived secrets exist — the client ID and the client secret — and they live in the systemd environment file, readable only by the service account. They are the natural first candidates for AWS Systems Manager Parameter Store when secret rotation becomes a requirement, and because the app is custom-distribution they are genuinely rotatable from the Dev Dashboard, which an admin-created custom app's credentials would not have been. The access token itself is never written to disk or to configuration: it is fetched at runtime by the token manager and held only in Redis under a TTL. That is a better position than the draft's permanent token, because the most sensitive credential in the system now has a maximum blast radius measured in hours. Note that the client secret does double duty as the webhook HMAC key, so rotating it requires the dual-secret acceptance window described below.

**Webhook authentication** is HMAC over the raw body, constant-time compared, with dual-secret acceptance during a rotation window. A failed verification returns 401, is logged with the source IP, and is counted — a rising rate of HMAC failures is either a misconfiguration or someone probing, and both deserve an alert.

**Customer data access logging** as described in §7.4, into the platform's existing append-only audit log.

**Retention** as a scheduled job: raw webhook payloads trimmed to metadata after thirty days, customer identifying fields nulled according to the policy Worood sets, both logged.

**Outbound egress.** The instance now makes outbound HTTPS calls to `*.myshopify.com`. This is worth an explicit security-group egress rule rather than blanket outbound access, and worth noting in any network review.

---

## 12. Infrastructure — revised EC2 requirements

### 12.1 Sizing

Adding a Redis instance, a second Node process and a continuously-growing data mirror changes the sizing conclusion of Module 1 §8.1. The `t3`/`t4g.medium` recommended there was sized for a booking system whose working set is small and whose traffic is spiky. It no longer fits.

| Component | Revised recommendation | Notes |
|---|---|---|
| Instance type | **`t4g.large`** (2 vCPU, 8 GB), unlimited mode enabled | Doubles memory over Module 1's `t4g.medium`, which is the binding constraint rather than CPU |
| Alternative | `m7g.large` (2 vCPU, 8 GB) | If burst credits prove tight once real traffic is observed; the sync jobs are steadier load than meeting-room bookings |
| Root volume | 30 GB gp3 | Unchanged |
| Data volume | **100 GB** gp3, 3000 IOPS | Up from 50 GB: order and line-item mirror, snapshot history, raw webhook payloads, WAL headroom |
| Operating system | Ubuntu Server 24.04 LTS | Unchanged |
| Redis | Local `redis-server`, bound to loopback | Not ElastiCache at this stage — see below |

Memory budget on 8 GB: PostgreSQL at 2 GB `shared_buffers`; Redis capped at 512 MB with `maxmemory-policy noeviction` so a full queue fails loudly rather than silently dropping jobs; the API process keeping Module 1's 1.5 GB systemd ceiling unchanged; the worker process capped at 768 MB; nginx negligible. That is about 4.8 GB of ceilings against 8 GB, leaving roughly 3 GB of page cache, which is where PostgreSQL gets most of its real benefit. `effective_cache_size` is set to 6 GB — a planner hint rather than an allocation, keeping Module 1's ratio of about three quarters of RAM.

**Local Redis rather than ElastiCache**, for now. A managed Redis would add roughly the cost of the instance itself to serve a workload that fits in half a gigabyte on a machine that is already running. The trade-off is that Redis shares the instance's failure domain — which is already true of PostgreSQL, so it changes nothing about the recovery model. Redis is configured with AOF persistence (`appendfsync everysec`) so a restart does not lose queued jobs; a lost job is a missed order update, which reconciliation would eventually repair but not before someone noticed. ElastiCache becomes the right answer at the same moment a second application instance does (§12.5).

### 12.2 Processes

Two systemd units instead of one. `worood-hub-api.service` changes only by gaining the Shopify and Redis environment variables and an `After=redis-server.service` ordering dependency; its memory ceiling, hardening directives and `ExecStartPre` migration step are untouched. `worood-hub-worker.service` runs the queue consumer and the schedulers, with the same hardening — unprivileged user, `ProtectSystem=strict`, `NoNewPrivileges`, private `/tmp`, memory ceiling — and `After=redis-server.service postgresql.service`. Migrations continue to run in the API unit's `ExecStartPre` only, so they run exactly once per deploy.

The worker is deliberately a separate unit and not a thread inside the API. It can be restarted, stopped during an incident, or moved to its own instance later without touching the request path.

### 12.3 Backup

Existing coverage extends naturally — the nightly `pg_dump` to S3 and the daily EBS snapshots now include the sales tables, and the Level 2 obligation to encrypt backups is met by EBS snapshot encryption and S3 server-side encryption, both of which the existing configuration already uses.

The distinction worth making explicit is that **the Shopify mirror is derived data.** If it is lost, it can be rebuilt from Shopify by bulk backfill, subject to the sixty-day window for order detail. What is *not* recoverable from Shopify is Worood's own material: dashboard definitions, widget layouts, access assignments, and snapshot history older than the order window. Those are small, they are the valuable part of this database, and the recovery rehearsal should verify them specifically rather than measuring success by total row count.

### 12.4 Monitoring

Beyond the existing CloudWatch alarms, this module needs alerts on things that fail quietly: webhook processing lag above five minutes; queue depth above a threshold; any dead-letter entry; a reconciliation watermark older than an hour; a ShopifyQL snapshot job that has not succeeded in two cycles; the subscription watchdog finding a subscription missing; Shopify 429 responses rising; and token refresh failures, which on a 24-hour token are the difference between a dashboard that is live and one that stops receiving anything at the same time tomorrow.

The failure mode this guards against is the specific one that makes internal dashboards untrustworthy: the dashboard keeps rendering yesterday's numbers and nobody notices for a week. Every sales dashboard therefore displays the age of its data in the header, and shows a visible banner rather than a stale figure when the data is older than a configurable threshold. That is a small piece of interface that does more for trust than any alarm.

### 12.5 Cost and growth

Moving from `t4g.medium` to `t4g.large` and from 80 GB to 130 GB of gp3, with the same Elastic IP, snapshots, S3 backups and CloudWatch, moves the indicative figure from the 60–90 USD per month in Module 1 to roughly **90–125 USD per month** on demand. The increment is modest and it is worth being explicit about why: one instance-size step is on the order of twenty-five dollars a month, the extra fifty gigabytes of gp3 a few dollars more, and the remainder is snapshot growth against a larger volume plus outbound traffic to Shopify. Redis adds nothing, because it runs on the instance already paid for. As with the original estimate, this should be confirmed in the AWS Pricing Calculator for the chosen region before budgeting, and a one-year Compute Savings Plan on the compute portion is worth taking once the instance size has settled after a month or two of real use.

The growth path is unchanged in shape. PostgreSQL moves to RDS by changing one environment variable. A second application instance behind an Application Load Balancer requires moving Redis to ElastiCache — which is the only new dependency this module introduces to that step, and the Socket.IO Redis adapter is already in place for it. If webhook delivery reliability ever becomes the constraint, Shopify can deliver to Amazon EventBridge instead of to an HTTPS endpoint, which removes both the five-second-response failure mode and the eight-failure auto-deletion entirely; that is a configuration change on the subscription plus an EventBridge consumer, not an application rewrite.

---

## 13. Test and verification plan

Module 1 was verified by seventy-six passing tests before its design document was written. This module should meet the same bar, and the following is what "done" means.

**Unit tests, on pure functions with no database and no network.** The sales formulas of §5.3 computed against hand-checked fixtures, including the average-order-value definition that excludes reversals. Timezone normalisation between Cairo days and UTC hours, including the boundary case where a Cairo day begins at 21:00 UTC the previous evening and the daylight-saving transition. The ordering guard: given a stored `updated_at` and an incoming payload, decide apply or discard, including the equal-timestamp case. Money parsing and shop-versus-presentment selection. The access-resolution function of §7.2 across the full matrix of role grants, individual grants and individual revocations, with and without `sales.dashboard.manage`.

**Integration tests against a real PostgreSQL and a real Redis.** Webhook receipt end to end: a correctly signed payload is accepted, stored, enqueued and applied. A payload with a bad signature returns 401 and writes nothing. The same delivery sent twice produces one row and one application — the deduplication assertion. Two deliveries for one order arriving out of order leave the later state, whichever arrives first. A worker crash mid-job leaves the job to be retried, not lost. Reconciliation repairs a deliberately dropped webhook. The token manager returns a cached token while it is valid, refreshes ahead of expiry, refreshes once — not once per caller — when twenty concurrent callers find it expired, and recovers rather than cascades when a refresh itself fails; given a 24-hour token this is the component whose failure is least visible and most total, so it is tested with the clock advanced rather than only in the happy path. A backfill JSONL stream with `__parentId` children reassembles into the correct line items.

**The response-time assertion.** The webhook endpoint responds within the deadline under load — the target is under 200 milliseconds at the ninety-fifth percentile with a hundred concurrent deliveries. This deserves the same prominence the concurrency test has in Module 1, because it is the equivalent single point of failure: a slow endpoint does not degrade, it loses the subscription.

**Authorisation tests.** An employee without `sales.dashboard.view` receives no sales portlets and 403 on every dashboard, widget and metrics route, while an employee holding only `sales.sync.manage` reaches the sync routes and is refused everywhere else — the two together prove the keys are independent rather than hierarchical. An employee with view but not `sales.customer.view` receives orders with customer fields absent from the JSON — asserted on the response body, not on the rendered page. A dashboard unassigned mid-session stops returning data on the next request and evicts the socket from its room. A widget requiring a permission the employee lacks is absent from the layout response.

**Reconciliation against Shopify.** The acceptance test that matters most to the people who will use this: for a chosen day, the dashboard's gross sales, discounts, reversals, net sales, total sales, order count and average order value each match the Shopify admin's own report for the same day in the same timezone, to the smallest currency unit. This should be run for a normal day, a day containing refunds, and a day containing a cancelled order. Until it passes, the dashboard is not finished.

**Manual verification**, mirroring Module 1's approach: the portal driven through a headless browser to confirm that sign-in, the home screen with the three new portlets, a sales dashboard, the composer, assignment and the sync screen all render and function, with screenshots retained.

---

## 14. Decisions needed before development starts

Two items that were blocking have been answered by Worood and are now settled: the store is on the **Advanced plan**, giving a 200-point-per-second rate-limit budget, and **a new app will be created** rather than an existing one reused. The one thing still to establish about the app is not a decision but a fact to look up, and it is first below.

**Same-organisation check (first hour, not a decision).** Confirm whether the Worood store appears under the Dev Dashboard organisation that will own the new app. If it does, the client credentials grant works and there is no install flow to build. If it does not, the app is installed through its custom-distribution link instead and a one-time OAuth callback route is needed. Either way the token manager is built; this only decides which method it calls. §4.9.

**Distribution method (irreversible, decide before creating the app).** Create the app with **custom distribution**, not public. It cannot be changed afterwards, it is what makes Level 2 customer data available without review or plan dependency, and public distribution offers this module nothing. Worth writing into whoever's hands create the app, because the choice is made in a dialog that gives no hint of its permanence.

**The revenue definition (blocking for the interface).** Given cash on delivery, confirm that the dashboard should lead with *sales ordered* and show *collected* alongside it, as §5.4 recommends, and confirm the wording Worood's finance team uses for each. Getting the vocabulary right matters as much as getting the arithmetic right.

**Bot filtering.** Include or exclude bot sessions in the traffic and conversion figures. Whichever is chosen, it must match how Worood reads the Shopify admin's own analytics, or the two will disagree.

**Retention policy for customer data.** Shopify sets no maximum and the obligation is purpose-bound, so Worood must choose a period and record it. A short one is easier to defend and reduces the surface of any future data protection review.

**Order history depth.** Is order-level detail beyond sixty days needed, or is ShopifyQL's aggregate history sufficient? This determines whether `read_all_orders` is requested and whether a large one-time backfill is in scope.

**Initial dashboards and assignment.** Which dashboards exist on day one, which widgets each contains, and who gets them. This is the input the seeder needs and it is a business conversation, not a technical one.

**Second store.** The schema is modelled for more than one store from the start. Confirm whether that is anticipated, because if it is, the widget and access model should be reviewed once more for store-level scoping before the tables are created rather than after.

---

## 15. Recommended sequence

Build in this order, because each step is verifiable before the next depends on it.

Create the app with custom distribution, check the same-organisation question, and get a token in hand through whichever of the two paths applies — this is an hour's work and it removes the only remaining unknown. Add the migration, the descriptor and the permissions, and verify that an administrator sees the new navigation and an ordinary employee does not — that single test proves the module is correctly wired into the platform before any Shopify code is written. Build the webhook receiver, the queue and the mirror, and verify with real deliveries. Add reconciliation and the subscription watchdog. Add the ShopifyQL snapshot jobs and prove the reconciliation-against-Shopify test passes for a chosen day. Only then build widgets, the dashboard renderer, and the composer, and add the real-time layer last — it is the part that is most visible in a demonstration and least important to correctness, and building it early tends to hide data problems behind pleasant animation.

The three home-screen portlets are the final step and the smallest one, because by then everything they display already exists.

---

## Appendix A — Repository additions

```
worood-hub/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── modules/
│   │       │   └── sales-dashboard/
│   │       │       ├── descriptor.ts          module registration
│   │       │       ├── shopify/               client · token manager · cost governor
│   │       │       ├── webhooks/              controller · HMAC guard · handlers
│   │       │       ├── sync/                  reconciliation · backfill · watchdog
│   │       │       ├── analytics/             ShopifyQL queries · snapshot jobs
│   │       │       ├── metrics/               widget data services
│   │       │       ├── dashboards/            composition · access resolution
│   │       │       └── realtime/              Socket.IO gateway
│   │       ├── queue/                         BullMQ setup, shared by future modules
│   │       └── db/migrations/0003_sales_dashboard.sql
│   └── web/
│       └── src/
│           ├── components/
│           │   ├── portlets/                  my-dashboards · store-pulse · my-alerts
│           │   └── widgets/                   registry · KPI · chart · table widgets
│           ├── lib/realtime/                  socket client · query invalidation
│           └── pages/sales/                   dashboard · orders · admin · sync
├── deploy/
│   ├── systemd/worood-hub-worker.service      new
│   ├── redis/worood-hub-redis.conf            new
│   └── nginx/worood-hub.conf                  websocket + webhook locations
```

## Appendix B — Shopify platform facts used in this document

Verified against Shopify's official developer documentation in August 2026, with several confirmed against the live Worood store. Anything not verifiable is marked as such and is not relied upon.

| Fact | Value |
|---|---|
| Current stable Admin API version | `2026-07`; supported until 16 July 2027 |
| Release cadence | Quarterly, each version supported at least 12 months |
| REST Admin API | Legacy since October 2024, maintenance mode; not used here |
| GraphQL rate limit | 100 / 200 / 1,000 points per second restore on Standard / Advanced / Plus — **Worood is Advanced, so 200**; 1,000-point cap per query; 250-item input arrays; bucket capacity unpublished, read from `throttleStatus` |
| Bulk operations | Exempt from cost limits; up to 5 concurrent queries per app from 2026-01; result URL expires after 7 days |
| Webhook response deadline | 5 seconds, documented; treat as the whole envelope |
| Webhook retries | 8 attempts over ~4 hours; Admin-API-created subscriptions deleted after 8 consecutive failures |
| Webhook ordering | Not guaranteed, within or across topics |
| Webhook duplicates | Possible; deduplicate on `X-Shopify-Webhook-Id` |
| Webhook signature | `X-Shopify-Hmac-Sha256`, base64 HMAC-SHA256 over raw body, keyed on the client secret |
| Compliance webhooks | Required only for App Store-distributed apps; not applicable |
| `shopifyqlQuery` | Present and not deprecated in 2026-07; requires `read_reports` and `read_customers`, and Level 2 customer data access |
| Sessions data | Available via `FROM sessions`; bot filtering is manual |
| Order object history | Last 60 days by default; `read_all_orders` for more; ShopifyQL is unaffected |
| Protected customer data | No app review for custom apps; Level 2 always available to a custom-distribution app, and not plan-dependent (the "varies by plan" caveat applies only to admin-created custom apps, which is not Worood's path); obligations apply regardless; no maximum retention period is set by Shopify |
| Analytics timezone | Shop timezone by default at day grain; hour grain emitted in UTC |
| Custom apps | Can no longer be created in the Shopify admin; existing ones continue to work; new apps are created in the Dev Dashboard. Distribution method is chosen once and is irreversible |
| Client credentials grant | Token expires after 24 hours (`expires_in: 86399`); requires the app and store to be in the same Shopify organisation, else `shop_not_permitted` |
| Expiring offline tokens for public apps | Reported for 1 January 2027, with custom and merchant-created apps exempt — from a changelog entry, so re-check before relying on it |

Five things are explicitly *not* asserted anywhere in this document, and should not be added later without a source. Shopify publishes no analytics freshness guarantee — the sub-hour lag observed on the Worood store is a measurement, not a commitment. It does not document whether ShopifyQL's `sales` schema excludes test orders; this should be established empirically during the build, since it determines whether a mirror-derived figure and a ShopifyQL figure are expected to agree exactly. It does not publish per-plan rate-limit bucket capacity. It does not document ShopifyQL's row or date-range ceilings, neither of which was reached in testing at five thousand rows or four years. And it does not state ShopifyQL's default timezone in prose — the shop-timezone default in §5.5 was established arithmetically against the live store rather than read from documentation, which is why every query in this design passes `WITH TIMEZONE` explicitly instead of relying on it.
