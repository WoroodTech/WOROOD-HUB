# WOROOD HUB — Shopify Integration

**Report on replacing the offline fixture pipeline with the live store**
Updated 1 September 2026

---

## 1. What this replaced

Module 2 was built and tested against JSON captured read-only from the Worood
store. That was the right call at the time: the Dev Dashboard app did not exist,
and the dashboard could be built, demonstrated and tested with no credentials
and no network.

The fixtures remain in the repository and still work. `FixtureShopifySource` is
what lets the metrics tests run without a token, without a network, and without
spending rate-limit budget. `SHOPIFY_TOKEN_STRATEGY=fixture` goes back to them.
What changed: the seed no longer loads them into the mirror, and live is now the
default path.

---

## 2. What was already built

More than expected. Before this work:

| Component | What it does |
|---|---|
| `LiveShopifySource` | GraphQL client with retry and backoff, handling HTTP 429 *and* the `THROTTLED` error Shopify returns inside a 200 |
| `TokenManager` | Client-credentials token with a Redis lock — twenty concurrent callers cause one refresh |
| `CostGovernor` | Shared token bucket in Redis, so API and worker cannot collectively exceed the restore rate |
| `ShopifyWebhookGuard` | HMAC-SHA256 over the raw body, constant-time, with dual-secret acceptance during rotation |
| `main.ts` | `rawBody: true` — without it the HMAC can never match |

So this was not a rewrite. It was wiring up what was missing and fixing what was
silently broken.

---

## 3. The two lanes

The single most important thing about how this module works, and the source of
most confusion during the build.

```
Shopify webhook  →  sd_orders            →  /sales/orders     (instant)
ShopifyQL        →  sd_metric_snapshots  →  dashboard KPIs    (on capture)
```

**Aggregates come from ShopifyQL. Individual records come from the Admin API.**
A dashboard figure is never computed by summing mirrored order rows when a
ShopifyQL metric exists for it.

Not a performance decision. Recomputing "total sales" from mirrored orders means
reimplementing Shopify's formula — order edits, partial refunds, duties, test
orders — and being wrong in a way nobody can explain. The first time a manager
checks a figure against the Shopify admin and finds it different, every other
figure becomes suspect.

The consequence was not obvious until it bit: a new order appeared in the orders
table immediately and left the headline figures untouched. That gap is now
closed on both the webhook path and the reconciliation path (§5.11, §5.14), but
the two-lane structure remains and is deliberate.

---

## 4. Features now connected

### 4.1 Initial sync — bulk backfill
**`sync/backfill.service.ts`** (new, 315 lines)

`bulkOperationRunQuery`. Bulk operations are exempt from both the
calculated-cost limit and the 1,000-point ceiling; Shopify runs the query on its
own side and returns a file.

That file is JSONL with **connections flattened** — an order and its line items
are separate lines, each child carrying `__parentId`, and children may appear
before or after their parent. Nothing is attached on the first pass: orders are
collected by id, orphans held aside, the two joined at the end. Attaching
eagerly would silently drop any line item Shopify emitted early.

The signed result URL expires after seven days, so it is downloaded promptly and
streamed line by line.

`POST /api/v1/sales/admin/sync/backfill` — accepts `{"since": "2026-01-01"}`.

### 4.2 Live updates — webhooks
**`webhooks/webhooks.ts`**, **`webhooks/webhook-processor.ts`**,
**`webhooks/topics.ts`** (new)

Nine subscriptions: `orders/create` · `orders/updated` · `orders/paid` ·
`orders/cancelled` · `orders/delete` · `refunds/create` · `customers/create` ·
`customers/update` · `bulk_operations/finish`

Four delivery properties drive the receiver:

- **Five-second deadline.** Verify signature, write the raw event, enqueue,
  return 200. No Shopify call or business logic on that thread.
- **No ordering guarantee.** Every write applies only if the payload's
  `updated_at` is at least as new as what is stored.
- **Duplicates happen.** `X-Shopify-Webhook-Id` is a unique column,
  `ON CONFLICT DO NOTHING` — absorbed at the database.
- **A failing subscription is deleted** after eight consecutive failures over
  about four hours. Hence the watchdog.

**Order hydration.** After the payload is applied, the order is re-read in full
with one GraphQL call and pushed through the same `upsertOrders` path the
backfill uses (§5.15).

### 4.3 Reconciliation
**`sync/sync.service.ts` → `reconcile()`**

Shopify states plainly that delivery is not guaranteed. Every fifteen minutes
this pulls every order whose `updated_at` falls after the last successful run,
**less a five-minute overlap**, through the same `upsertOrders` path.

The overlap matters: an order updated in the same second the previous run read
the clock would otherwise fall between two passes forever. The watermark
advances only on success.

Webhooks make the dashboard feel live; reconciliation makes it true.

### 4.4 Analytics — ShopifyQL snapshots
**`analytics/snapshot.service.ts`**

Live ShopifyQL per page view would be slow and would make the dashboard's
responsiveness a function of Shopify's. Results are captured into
`sd_metric_snapshots`; widgets read PostgreSQL.

Three things this layer has to get right: ShopifyQL aggregates day-grain in the
shop's timezone but emits hour-grain in UTC, so every query passes
`WITH TIMEZONE 'Africa/Cairo'` and every row stores the zone it was aggregated
in; bot filtering is not automatic, and omitting it inflates sessions and
depresses conversion; and `conversion_rate` is a fraction — `0.0119` is 1.19% —
despite being typed as a percentage.

### 4.5 Scheduling
**`sync/scheduler.service.ts`** (new, 178 lines)

Before this, nothing ran on a timer. Every job existed as a method somebody
could POST to, so the mirror only advanced when a human remembered.

| Job | Cadence | Why |
|---|---|---|
| reconciliation | 15 min | the practical upper bound on how long a missed webhook goes unnoticed |
| snapshots | hourly | day *and* hour grain — see §5.13 |
| nightly snapshot | 02:00 Cairo | thirteen months plus breakdowns; corrects revised figures |
| watchdog + retention | 03:00 Cairo | Shopify deletes a failing subscription silently |

Each runs once at startup after a short stagger, skips rather than overlaps, and
catches its own failures so one bad cycle does not stop the schedule.

### 4.6 Shop settings
**`sync/sync.service.ts` → `syncShopSettings()`**

Currency, timezone, name and plan read from Shopify rather than inherited from
the fixture. These are *settings*, not constants — Egypt observes daylight
saving and a store can be re-denominated — so this is a sync step.

---

## 5. Problems hit, and how each was solved

### 5.1 Redis was not running, and the server hung instead of saying so

**Symptom:** `/diagnostics` spun forever. No error, no timeout, no response.

**Cause:** `maxRetriesPerRequest: null` — retry forever — paired with an error
handler that only logged a warning. The server started up looking healthy and
hung the first request that touched Redis. From outside, the symptom is a
spinner.

**Fix, in two steps.** First `enableOfflineQueue: false`, which fixed the hang
but was an overcorrection — a routine reconnect then failed the in-flight
request with `Stream isn't writeable`. Final version: offline queue on,
`commandTimeout: 5000`. A queued command waits for a reconnection that is
actually coming and gives up after five seconds when one is not.

Separately, `CostGovernor.acquire()` now **proceeds** when Redis is unavailable.
The governor exists to avoid a 429; a 429 is a retry, while a hard failure there
is a dashboard that does not load. The token cache still fails, because without
it there is no call to make.

**Environment:** Redis runs in WSL Ubuntu and does not start on boot —
`wsl -d Ubuntu -e sudo service redis-server start` after each Windows restart.

### 5.2 The wrong shop domain

Requests returned Shopify's admin login page as HTML. `SHOPIFY_SHOP_DOMAIN` was
unset, so the config default `worood-designs.myshopify.com` was used. The real
store is `worood-wqxgoidw.myshopify.com` — visible in the `redirect_uri` inside
the HTML.

### 5.3 200 OK and nothing in it

`LiveShopifySource.shopifyql` ended with
`return { columns: r?.tableData?.columns ?? [], … }`. That `?? []` turned
"Shopify refused" into "there were no sales". Zero rows written, 200 returned,
dashboard empty, no error anywhere.

**Fix:** a null response now throws, naming the two usual causes — a missing
`read_reports` scope, or a token not valid for this shop.

### 5.4 Nothing exposed what the server actually believed

Diagnosing §5.2 and §5.3 meant guessing.

**Added** `GET /api/v1/sales/admin/sync/diagnostics`: source kind, token
strategy, shop domain, API version, whether credentials are set (truncated id,
secret as present/absent), a Redis check, and a live `ping()` returning shop
name, plan, and **the scopes Shopify says the app actually holds**. Redis is
checked first and separately — otherwise every Shopify verdict is a misleading
proxy for "Redis is down".

This found §5.6 and the missing `read_reports` in one call.

### 5.5 Webhook registration was never implemented

**The most serious finding.** `verifyWebhooks()` queried for missing
subscriptions and notified `sales.sync.manage` holders they had been
*"Re-registered"* — while **no code anywhere called
`webhookSubscriptionCreate`**. The notification was false. Shopify was never
asked to deliver anything; the entire fast path did not exist.

**Fix:** `registerWebhooks()` genuinely registers, and the watchdog
re-registers before claiming it did. It refuses when
`SHOPIFY_WEBHOOK_BASE_URL` is empty rather than pointing a subscription at an
unreachable address — which fails eight times over four hours and is then
deleted, leaving a dashboard that looks healthy and receives nothing.

### 5.6 Scopes are granted at install, not at version release

A new app version listed `read_reports` and `read_analytics`; `ping()` returned
the old set including `write_products`. Releasing a version updates the app
definition — the store still holds the old consent. **Fix:** reinstall on the
store, then restart so the cached token (which carries the scopes granted at
issue) is dropped.

### 5.7 Backfill failed minutes in with ACCESS_DENIED

`customer { … }` and `shippingAddress { … }` are **protected customer data**.
`read_customers` is not sufficient — access must be granted explicitly. And a
bulk operation does not reject these at submission: it accepts, runs, and fails
minutes later, losing the whole export for four columns nobody was blocked on.

**Fix:** on `ACCESS_DENIED` the backfill retries without the protected fields.
Order totals, line items and every headline figure survive.

**Still outstanding.** The Dev Dashboard has not offered the option to enable
protected customer data access for this app.

### 5.8 ShopifyQL's response shape changed in 2026-07

`No such type TableResponse, so it can't be a fragment condition`. Through
2026-04 the response was a union and the table arrived behind
`... on TableResponse`. In 2026-07 that type is gone, so the *whole query* is
rejected with `undefinedType` rather than returning partial data.

**Fix:** fragment removed, `rowData` → `rows`, and `parseErrors` handled as both
strings (2026-07) and objects (earlier) so a version bump in either direction
does not turn a readable error into `[object Object]`.

### 5.9 `sales_reversals` exists after all

The design document recorded the column as absent and derived it as
`(gross + discounts) − net`. No longer true: 2026-04 renamed the old `returns`
family to `sales_reversals` — same definition, clearer name, since the figure
always covered refunds, cancellations and edits rather than only physical
returns — and 2026-07 removed the old names. The query now asks for it directly,
so `net_sales = gross_sales − discounts − sales_reversals` closes on Shopify's
own arithmetic.

### 5.10 Order deletion could never be detected

`orders/delete` was not registered, so Shopify never reported it. And
reconciliation cannot detect deletion in principle: it asks for orders whose
`updated_at` moved, and a deleted order stops being returned. **Absence is not
an event a delta pull can observe.**

**Fix:** topic registered, handler added, migration `0008` adding `deleted_at`.
Soft, not hard — the row is the only remaining record, since Shopify will not
serve the order again. Read paths filter on `deleted_at IS NULL`, in one shared
clause so the list and its totals cannot drift apart.

### 5.11 Dashboard figures did not move when an order arrived

The two lanes of §3. The webhook writes `sd_orders`; the dashboard reads
`sd_metric_snapshots`. Nothing connected them.

**Fix:** `SnapshotService.scheduleRefresh()`, called from the webhook processor
on order and refund events. The 45-second delay is not only about batching:
**Shopify publishes no freshness guarantee for analytics.** An order does not
appear in ShopifyQL the instant its webhook is delivered, so capturing
immediately would capture the figures from *before* the order and write them as
current — which would look exactly like a bug. A confirming pass runs four
minutes later.

### 5.12 Jobs waited a full interval before their first run

A freshly started server reported "the oldest figure was read 22 hours ago" and
kept reporting it for an hour. `setInterval` fires after the first period, not
at zero — so nothing ran until an interval elapsed. On the overnight jobs a
restart at 01:59 would wait until 02:59.

**Fix:** `runAtStartup` with a staggered delay, which keeps the jobs off the
critical path while the first requests are served and stops them all calling
Shopify in the same second.

### 5.13 The freshness banner could never be cleared

Even after §5.11 and §5.12, the banner persisted.

**Cause, and it was mine.** `refreshRecent()` updated seven days on the
reasoning that an order changes today's bucket, never last March. The arithmetic
was right and the conclusion wrong: the banner reports the age of the *oldest*
figure on the page, and every snapshot row carries its own `captured_at`. On a
ninety-day view, rows eight to ninety kept their old timestamps. The oldest
figure stayed old no matter how many times the recent end was refreshed.

**A second instance of the same mistake:** the hourly job captured hour grain
only, so day rows were refreshed nightly and were routinely twenty-four hours
old against a 180-minute budget. The banner was **guaranteed** to appear every
afternoon whether or not anything was wrong — the fastest way to teach people to
ignore a warning.

**Fix:** both the automatic refresh and the hourly job now capture day and hour
grain together, which is what a manual capture always did.

### 5.14 Two jobs collided at startup and were throttled

```
11:09:17  reconciliation initial run → 3 orders → refresh scheduled
11:09:31  that refresh ran → 792 rows
11:09:32  hourly snapshot initial run → called the same thing again
11:09:33  throttled ×5 → failed
```

**Two causes.** The `running` guard was per-job, not on the shared resource —
two different jobs both call `refreshRecent()`. And the backoff was
`Math.random() * ceiling`, full jitter, which allows a near-zero sleep at any
attempt: five retries finished in six seconds, and against a bucket refilling at
200 points a second that is not long enough for an expensive query to become
affordable.

**Fix:** an in-flight promise on `refreshRecent()` itself, so a second caller
joins the run in progress and gets the same answer — correct, since both would
have queried the same range. And the backoff now has a floor: half the window
fixed, half jittered, so each attempt is guaranteed longer than the last. Six
attempts, roughly a minute of patience — the right trade for a scheduled
capture, where finishing late is fine and failing is not.

### 5.15 Orders appeared incomplete and filled in over minutes

A new order showed with no items, no customer and nothing collected, then
completed itself over the following minutes.

**Correct behaviour, and it reads like a bug.** A webhook payload is a snapshot
of one moment, and for `orders/create` that moment is often before the order is
finished being assembled: line items added in a second step, a customer attached
after, payment captured later. `orders/updated` and `orders/paid` fill in the
rest.

**Fix:** after the payload is applied, the order is re-read in full with one
GraphQL call and pushed through the same `upsertOrders` path the backfill uses —
so an order written by a webhook and one written by a bulk export are the same
row built the same way. It runs *after* the payload, not instead of it, so a
failed fetch costs richness rather than the record. Protected customer fields
are deliberately not requested: the payload already carried them, and asking
again risks the whole read being denied and losing the line items with it.

`collected` staying at zero until payment is **not** part of this. It reads
`netPaymentSet` — money actually received. On a cash-on-delivery store the gap
between *ordered* and *collected* is the money in transit with couriers, and the
design document calls it the most operationally interesting number on the
screen.

### 5.16 An import cycle blocked the hydration fix

`sync.service` imported `WEBHOOK_TOPICS` from `webhooks.ts`, which imports the
processor. Having the processor import `SyncService` closed the loop.

**Fix:** `webhooks/topics.ts` — the list in its own file with no imports.
A constant that everything needs and that needs nothing should never sit in a
file with dependencies.

### 5.17 ngrok

Shopify delivers from its own network and cannot reach `localhost`, so the fast
path cannot work locally without a tunnel. Registration refuses without
`SHOPIFY_WEBHOOK_BASE_URL` rather than registering a doomed subscription.

Two things to know: the free-tier URL **changes** on every restart, and
subscriptions registered against the old address are deleted by Shopify after
eight failures. And the free tier interposes a browser warning page on the first
request from each IP, which Shopify sees as a non-2xx — add
`--request-header-add "ngrok-skip-browser-warning:true"` if deliveries stop.

### 5.18 The scheduler defaulted to off

`SHOPIFY_SCHEDULE_ENABLED` had to be set to `true` explicitly. The reasoning was
that a developer should not start calling Shopify on a timer without meaning to
— but the effect was that someone who had gone to the trouble of configuring
live credentials got a dashboard that never updated itself and had to discover
an undocumented variable. Nothing about that is safer; it is just quieter.

**Fix:** on by default when the source is live. The real guard is the token
strategy — in fixture mode the scheduler does not start at all. Set to `false`
to opt out, which is worth doing when two machines point at the same store.

### 5.19 Currency mismatch

The orders page showed `EGP 1,269` in the summary and `USD 154` in the rows —
the total was a sum of dollars wearing a pound sign. `sd_shops` came from the
fixture (Worood's real store, EGP) while orders came from the development store
(USD). Addressed by §4.6; not yet run.

---

## 6. Files

### New

| File | Responsibility |
|---|---|
| `sync/backfill.service.ts` | Bulk operation, JSONL streaming, `__parentId` reassembly, ACCESS_DENIED retry |
| `sync/scheduler.service.ts` | Four cadences, startup runs, overlap-skip, error isolation |
| `webhooks/topics.ts` | The topic list, dependency-free |
| `db/migrations/0008_sales_order_deletion.sql` | `deleted_at` on `sd_orders` + partial index |

### Modified

| File | What changed |
|---|---|
| `sync/sync.service.ts` | `reconcile()`, `registerWebhooks()`, `syncShopSettings()`, `/diagnostics`, real re-registration in the watchdog, Shopify's own error text passed through |
| `shopify/shopify.service.ts` | ShopifyQL 2026-07 shape; fail loudly on null; `ping()`; Redis command timeout; `AbortSignal.timeout` on fetch; cost governor degrades rather than refuses; floored backoff, six attempts |
| `analytics/snapshot.service.ts` | `refreshRecent()` with in-flight lock, `scheduleRefresh()`, `sales_reversals` restored, `ShopContext.invalidate()` |
| `webhooks/webhook-processor.ts` | Deletion handler, snapshot refresh trigger, order hydration |
| `webhooks/webhooks.ts` | Topics moved out and re-exported |
| `dashboards/dashboards.controller.ts` | `deleted_at IS NULL` in one shared clause |
| `metrics/metrics.service.ts` | `deleted_at IS NULL` on pulse and recent-orders |
| `common/config.ts` | `webhookBaseUrl`, `scheduleEnabled` (default on) |
| `db/seed.ts` | Stopped writing `sd_orders` and `sd_metric_snapshots`; 142 lines of fixture loaders removed; sync state seeded `PENDING` with no watermark |

**On the seed's sync state:** it previously wrote `status = 'OK', watermark =
now()`. Left alone, the first reconciliation would read that watermark, conclude
the last day was already covered, and skip it.

---

## 7. Verified working

| | |
|---|---|
| Token via client credentials | ✅ 24-hour expiry, cached in Redis |
| `ping()` | ✅ shop, plan, scopes |
| Backfill | ✅ orders through the bulk path |
| Snapshots | ✅ 792 daily + 192 hourly + 9 breakdown rows |
| Webhook registration | ✅ all topics |
| Live order delivery | ✅ order created in Shopify appeared in WOROOD HUB |
| Reconciliation | ✅ 3 orders on a cold start |
| Scheduler | ✅ initial runs at startup, then on cadence |

---

## 8. Outstanding

**Blocking a claim of "finished":**

- **Figures reconciled against the Shopify admin.** For one chosen day, gross
  sales, discounts, reversals, net sales, total sales, order count and average
  order value must each match the admin's own report for the same day in the
  same timezone. Run for a normal day, a day with refunds, and a day with a
  cancellation. Until this passes, the dashboard is not finished.

**Ready but not run:**

- `npm run migrate` for `0008`, then re-register so `orders/delete` takes effect
- `POST /sales/admin/sync/shop` for currency and timezone

**Not yet tested:**

- Refund, cancellation and order-edit webhook paths
- The sales-vs-collected split the cash-on-delivery model turns on
- Permission boundaries against live data (Omnia sees no dashboards; Heba sees
  orders without customer identity)

**Blocked externally:**

- Protected customer data access — the Dev Dashboard has not offered the option

**Environmental:**

- Redis must be started manually after each Windows restart
- The ngrok URL changes on restart; `.env` and the subscriptions both need
  updating

**Worth revisiting at real volume:**

- Reconciliation asks for a full capture whenever it writes anything. On a store
  with steady orders that is a 395-day ShopifyQL query four times an hour.
  Narrowing the reconciliation-triggered refresh and leaving the full capture to
  the hourly job would be the fix — but the right shape depends on numbers that
  do not exist yet on a development store.

**Unrelated to Shopify, from the Module 1 review:**

- The changeover buffer is enforced only in application code. The GiST exclusion
  constraint sees the raw time range, so two concurrent bookings closer together
  than the buffer would both be accepted. Every room is at 0 today.



# Compare two days — where each file goes

| File | Goes to |
|---|---|
| `api/metrics.service.ts` | `apps/api/src/modules/sales-dashboard/metrics/` |
| `api/snapshot.service.ts` | `apps/api/src/modules/sales-dashboard/analytics/` |
| `api/dashboards.controller.ts` | `apps/api/src/modules/sales-dashboard/dashboards/` |
| `api/sync.service.ts` | `apps/api/src/modules/sales-dashboard/sync/` |
| `web/pages/SalesDashboard.tsx` | `apps/web/src/pages/` |
| `web/charts/SeriesChart.tsx` | `apps/web/src/charts/` |
| `web/widgets/WidgetCard.tsx` | `apps/web/src/widgets/` |
| `web/styles.css` | `apps/web/src/` |
| `contract/web-contract.ts` | `apps/web/src/contract.ts` |
| `contract/api-contract.ts` | `apps/api/src/contract.ts` |
| `contract/packages-contract-index.ts` | `packages/contract/index.ts` |

No migration, no seed change. Build and restart.

---

## What it does

A **Compare days** button beside the existing range buttons. Pressing it reveals
two date pickers; the dashboard then shows the first day with the second held
against it.

The rolling ranges — Today, 7 days, 30 days, 90 days, 13 months — are untouched.
This is a sixth mode beside them.

**KPIs** show the first day's figure with the percentage measured against the
second, and the label reads *vs 4 Sep 2026* rather than *vs previous 30 days*.
Every KPI already passed `range.comparisonLabel` straight through, so this
needed no per-widget change.

**Sales trend and orders trend** draw two lines: the chosen day solid, the
comparison day dashed.

**Donuts and tables** stay on the first day. Splitting a top-products table in
two would need a column layout nobody asked for, and the question people bring
to a comparison is how the shape of a day changed — which is a line chart.

---

## Run this once after deploying

```
POST /api/v1/sales/admin/sync/snapshots/hourly-backfill
```

Fills 13 months of hour-grain buckets so comparisons against older dates read
from PostgreSQL rather than calling Shopify. Takes a few minutes; runs in
monthly slices because a year of hourly data in one query is exactly the shape
that gets throttled. `{"months": 3}` for a shorter fill.

## Comparison figures: store first, Shopify only on a miss

This is the part worth understanding, because the first version got it wrong.

The hourly snapshot capture covers **three days**. Stored hour buckets therefore
reach back only as far as the job has been running — so a day chosen from a
calendar was usually not in them, and every figure came back zero. Worse than
zero: the headline number was read from the *daily* snapshots, which go back 395
days, so the number above stayed correct while the percentage below it moved
against nothing. A dashboard that is wrong in a way that looks right.

ShopifyQL has no such limit. `TIMESERIES hour SINCE <day> UNTIL <day>` answers
for any date in the store's history — which is what the query you found does.

So comparison mode reads hour grain for the two chosen days — from the snapshot
store when it is there, from ShopifyQL when it is not, and whatever is fetched
is written back so the next reader gets it from the store.

Three changes make that work:

**The routine hourly capture went from 3 days to 14.** Three was sized for the
pulse strip, which only looks at today and yesterday. Fourteen covers the
comparisons people actually make — this week against last — for about 670 extra
rows, which is nothing beside a 92,000-order mirror.

**A one-off backfill fills 13 months**, so older comparisons are already there.

**A day is served from the store only if it is complete.** A capture that ran
half-way through a day would otherwise read as a quiet day rather than a partial
one — wrong in a way that looks like a business problem rather than a data
problem. Today is never served from the store, because the current hour is still
moving. Shopify emits no bucket for an hour with no activity, so the rule is a
tolerance rather than an exact count: 18 buckets on a quiet day is fine, 5 is a
capture that did not finish.

Reading from the store also means a Shopify outage leaves the comparison working
rather than blank. Calling an external service while rendering a screen makes
their downtime your downtime.

**Within one request, one call per day per schema.** Five widgets wanting the
same two days were each making their own round trip — ten network calls for one
page, spaced further apart by the cost governor, and the browser gave up before
the server answered. Callers now join a fetch already in flight, and the result
is held for a minute afterwards. Failures are not cached, and the map is bounded,
since the keys are user-chosen dates.

## Three decisions worth knowing

**Days, not ranges.** Two single days are the same length by construction, so
hours line up one to one. Arbitrary ranges would need a rule for what happens
when three days are held against seven, and every rule available there is a
compromise someone has to be told about.

**The comparison day is re-stamped onto the primary day's clock** before it is
sent. Without that the two lines sit side by side on a 48-hour axis instead of
overlaying, and the comparison is invisible. The real date travels in the series
label, so nothing is hidden — only aligned.

**Dashes, not a lighter colour.** The distinction has to survive being printed
and being read by someone who does not see the two hues apart. On the orders
chart the comparison is drawn as a line over the bars rather than a second bar
set: two bar sets for the same hour either hide each other or halve in width.

---

## Also in these files

**The "computed here" badge was lost in a merge.** `WidgetCard.tsx` still had
the import and the explanatory comment, but the badge itself was gone — so the
Customer Insights and Store Credit widgets were rendering without the mark that
says they cannot be reconciled against the Shopify admin. Restored.

---

## One thing to fix separately

`apps/api/src/db/migrations/` contains **`011_abandoned_checkouts.sql`** —
missing a leading zero. The runner applies files in lexical order, and `011`
sorts *after* `0014`, so the abandoned-checkout table is created last. Nothing
depends on it, so nothing breaks, but rename it to `0011_abandoned_checkouts.sql`
before the ordering matters to something.

Note the runner records each file's name and checksum, so renaming an
already-applied migration means it will be seen as new and re-run. It is
`CREATE TABLE IF NOT EXISTS` throughout, so re-running is harmless — but check
`core_migrations` afterwards and delete the stale `011` row if you want the
table to stay tidy.

---

## Trying it

1. Open **Sales → Executive Daily**
2. Press **Compare days**
3. Pick two dates — it opens on yesterday and the day before

Today is deliberately not the default: comparing a part-day with a whole one
makes the first look worse for no reason. It is still selectable.

The two dates live in the URL beside the range, so a comparison can be shared or
bookmarked the way a range already can.