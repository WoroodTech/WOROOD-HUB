# WOROOD HUB — Sales Dashboard Reference

**Where every number comes from, and how often it changes**
7 September 2026

---

## 1. The rule everything follows

```
Shopify webhook  →  mirror tables        →  order-level figures
ShopifyQL        →  sd_metric_snapshots  →  headline figures
```

**Aggregates come from ShopifyQL. Individual records come from the Admin API.**
A dashboard figure is never computed by summing mirrored order rows when a
ShopifyQL metric exists for it.

This is why the numbers reconcile with the Shopify admin. Recomputing "total
sales" from mirrored orders would mean reimplementing Shopify's formula —
order edits, partial refunds, duties, test orders — and being wrong in a way
nobody can explain. The first time a manager checks a figure and finds it
different, every other figure on the screen becomes suspect.

**One exception, marked on screen.** Cohort retention, repeat-purchase rate and
RFM segmentation have no ShopifyQL metric to read — Shopify computes them
internally for its own reports and does not expose them. Those are derived from
the mirror, carry `computedLocally: true`, and show a **"computed here"** badge
whose tooltip says they cannot be checked against the admin.

---

## 2. Sync cadences

| Job | Every | What it does |
|---|---|---|
| **Webhook delivery** | seconds | The fast path. 15 topics. |
| **Reconciliation** | 15 min | Pulls every order whose `updated_at` moved since the last run, less a 5-minute overlap. Watermark advances only on success. |
| **Abandoned checkouts** | 30 min | Re-reads the last 30 days. Full window each time, not a delta — see §5. |
| **Snapshots** | 1 hour | ShopifyQL: 13 months at day grain, 3 days at hour grain, plus breakdowns. |
| **Nightly snapshot** | 02:00 Cairo | Same, and corrects figures Shopify has since revised. |
| **Store credit** | 02:00 Cairo | Bulk export over every customer. |
| **Watchdog + retention** | 03:00 Cairo | Re-registers deleted subscriptions; trims raw payloads and PII. |

Each job runs once at startup after a stagger (10s / 20s / 30s / 45s), skips
rather than overlaps, and catches its own failures so one bad cycle costs a
cycle rather than the schedule.

**A webhook also triggers a snapshot refresh**, debounced 45 seconds. The delay
is not only batching: Shopify publishes no freshness guarantee for analytics, so
capturing the instant a webhook lands would capture the figures from *before*
the order and write them as current. A confirming pass runs four minutes later.

---

## 3. The 15 webhook topics

| Topic | Updates |
|---|---|
| `orders/create` · `updated` · `paid` · `cancelled` | order + line items + refunds + customer stats + snapshots |
| `orders/delete` | soft delete + customer stats + snapshots |
| `refunds/create` | refund + order re-read + customer stats + **store credit** + snapshots |
| `customers/create` · `update` | customer identity only |
| `customers/delete` | soft delete |
| `checkouts/create` · `update` · `delete` | checkout recovery state |
| `shop/update` | currency + timezone + full re-capture |
| `app/uninstalled` | sync state marked ERROR, logged loudly |
| `bulk_operations/finish` | backfill ingestion |

Four delivery properties shape the receiver: a **five-second deadline** (verify,
store, enqueue, return 200 — nothing else on that thread); **no ordering
guarantee** (every write applies only if the payload is at least as new as the
stored row); **duplicates happen** (`X-Shopify-Webhook-Id` is unique, absorbed
at the database); and **a failing subscription is deleted** after eight
consecutive failures — hence the watchdog.

---

## 4. Every widget and its source

### From ShopifyQL snapshots — hourly, plus a refresh on each order

| Widget | Figure |
|---|---|
| `kpi-total-sales` | `total_sales` — net sales plus shipping, tax, duties |
| `kpi-gross-sales` | `gross_sales` — before discounts and returns |
| `kpi-discounts` | `discounts` |
| `kpi-returns` | `sales_reversals` — refunds, returns, cancellations, edits |
| `kpi-net-sales` | `net_sales` = gross − discounts − reversals |
| `kpi-orders` | `orders` |
| `kpi-aov` | `average_order_value` = (gross − discounts) ÷ orders |
| `chart-sales-trend` · `chart-orders-trend` | day or hour series |
| `table-top-products` | breakdown by `product_title`, 90 days |

`net_sales = gross_sales − discounts − sales_reversals` closes on Shopify's own
arithmetic. `sales_reversals` was absent when the fixtures were captured and was
derived; API 2026-04 renamed the old `returns` family to it, so it is asked for
directly now.

### From ShopifyQL sessions — hourly only

| Widget | Figure |
|---|---|
| `kpi-sessions` · `kpi-conversion` | sessions, conversion rate |
| `chart-sessions-trend` · `funnel-conversion` | traffic and the cart→checkout→purchase funnel |
| `donut-traffic-sources` · `donut-devices` · `table-top-countries` | breakdowns |

Bot traffic is excluded (`human_or_bot_session = 'human'`) — omitting it inflates
sessions and depresses conversion. `conversion_rate` arrives as a fraction:
`0.0119` is 1.19%.

### From the order mirror — seconds

| Widget | Figure |
|---|---|
| `kpi-collected` | `SUM(net_payment)` — money actually received |
| `kpi-outstanding` | ordered less collected — the cash-on-delivery float |
| `table-recent-orders` | latest 15, customer columns behind `sales.customer.view` |

### From customer analytics — seconds, `computed here`

| Widget | Figure |
|---|---|
| `kpi-new-vs-returning` · `donut-new-vs-returning` | share of orders from someone who had bought before |
| `kpi-repeat-rate` | of customers who bought in range, share who ever bought twice |
| `kpi-returning-revenue` | revenue from returning customers |
| `kpi-time-to-second-order` | median days to the second order |
| `donut-customer-segments` | Champions / Growing / New / Cooling / At risk / Lapsed |
| `bar-order-frequency` | 1 / 2 / 3–5 / 6–10 / 11+ orders |
| `chart-acquisition` | new customers against orders from earlier ones |
| `table-cohort-retention` | by first-purchase month, return within 1/3/6/12 months |
| `table-top-customers` | by lifetime spend |

### From abandoned checkouts — 30 min, recovery in seconds

| Widget | Figure |
|---|---|
| `kpi-abandoned` · `kpi-abandoned-value` | count, and value still uncollected |
| `kpi-recovery-rate` · `kpi-recovered-value` | share later completed, and its value |
| `chart-abandonment` · `donut-abandoned-age` | trend, and how long the open ones have sat |
| `table-open-checkouts` | the working list, with a recovery URL per row |

### From store credit — refunds in seconds, manual edits nightly

| Widget | Figure |
|---|---|
| `kpi-credit-issued` · `kpi-credit-spent` | credits and debits, summed separately |
| `kpi-credit-outstanding` | total balance held — a liability |
| `kpi-credit-redemption` | spent ÷ issued in the window |
| `chart-credit` · `donut-credit-events` | trend, and Shopify's own reason codes |
| `table-credit-holders` | largest balances |

---

## 5. Three decisions that are not obvious

**Abandoned checkouts re-read a full 30 days every cycle, not a delta.**
`AbandonedCheckoutSortKeys` has no `UPDATED_AT`, so there is no way to walk what
changed. Ordering by creation would never revisit a checkout created three weeks
ago and completed today, and the recovery would be missed. Re-reading is cheap
at this volume and is the only way recovery stays correct.

**Store credit direction comes from the type name, and a Revert inverts it.**
Four types exist: `Credit` (+), `Debit` (−), `DebitRevert` (+, a spend given
back), `CreditRevert` (−). A plain `/Debit/` test reads `DebitRevert` as a
debit, which is backwards — one customer's ledger summed to 100 against a
Shopify balance of 300 before this was found.

**Every derived column has exactly one writer.** `orders_count`,
`first_order_at`, `last_order_at` and `total_spent` are recomputed from
`sd_orders` by `refreshCustomerSpend`, on the same filters the reports use.
Nothing else touches them. They previously had three writers between them and
changed depending on which webhook arrived last — a repeat-purchase rate that
moved when a customer edited their phone number.

Exclusions applied to every customer figure: `test = false`,
`cancelled_at IS NULL`, `deleted_at IS NULL`, and a non-null `customer_id`.
Guest orders cannot participate in a customer metric.

---

## 6. What is *not* live, and why it cannot be

**Sessions and traffic — up to one hour.** Shopify has no webhook for a page
view. Not missing; not possible. Visitor analytics are aggregated on Shopify's
side and served through ShopifyQL by pull. Hourly is the floor.

**Manual store credit adjustments — up to 24 hours.** Shopify publishes no
webhook topic for store credit transactions. Credit arising from a *refund* —
the overwhelming majority — updates in seconds via `refunds/create`; only a
staff member adding credit by hand waits for the nightly export.

Both are stated on screen: every dashboard shows the age of its data and a
banner when it exceeds the freshness budget.

---

## 7. Verification

```
GET /api/v1/sales/admin/sync/reconcile-check?date=YYYY-MM-DD
```

Compares three independent sources for one day: Shopify's own order count,
ShopifyQL's aggregate, and the mirror. The verdict rests on ShopifyQL against
the mirror — the two that feed the dashboards — with Shopify's raw count as a
third opinion, because it counts drafts and tests the other two exclude.

**Result for 6 September 2026: all three returned 113.**

```
gross 255,130 − discounts 60,807 − reversals 20,064 = net 174,258  ✓
ordered 207,644 · collected 76,455 · with couriers 131,189
```

Worth running every week or two. It is the cheapest thing that will tell you
something has broken, before anyone sees a wrong number and stops trusting the
screen.

Other checks:

```sql
-- customer counts sit on one basis
SELECT COUNT(*) FROM sd_customers c WHERE c.deleted_at IS NULL
   AND c.orders_count <> (SELECT COUNT(*) FROM sd_orders o
      WHERE o.customer_id = c.id AND o.test = false
        AND o.cancelled_at IS NULL AND o.deleted_at IS NULL);

-- the store credit ledger closes on Shopify's balance
SELECT c.display_name, c.store_credit_balance, COALESCE(SUM(t.amount), 0)
  FROM sd_customers c
  LEFT JOIN sd_store_credit_transactions t ON t.customer_id = c.id
 WHERE c.store_credit_balance > 0
 GROUP BY c.id, c.display_name, c.store_credit_balance
HAVING ABS(c.store_credit_balance - COALESCE(SUM(t.amount), 0)) > 0.01;
```

Both must return zero rows. The store credit check also runs after every sync
and warns in the log — it is what found two separate bugs.

---

## 8. Dashboards and access

| Dashboard | Widgets | Granted to |
|---|---|---|
| Executive Daily | 7 | executive, finance |
| Sales Operations | 5 | executive, operations |
| Marketing and Traffic | 7 | executive, marketing |
| Finance Reconciliation | 7 | executive, finance |
| **Customer Insights** | 10 | executive, finance, marketing, customer-care |
| **Checkout Recovery** | 7 | executive, marketing, operations, customer-care |
| **Store Credit** | 7 | executive, finance, customer-care |
| Combined Sales and Marketing | 7 | executive, marketing |

Access resolves per request, never cached in the token: without
`sales.dashboard.view` nothing is returned at all; with `sales.dashboard.manage`
everything is; otherwise it is the union of role grants plus individual GRANTs
minus individual REVOKEs. Widgets whose permission the employee lacks are
dropped from the layout before it leaves the server, so a widget cannot be
revealed by manipulating the client.

Customer names, emails and cities require `sales.customer.view` and are
**omitted from the JSON**, not blanked in the browser.

---

## 9. Coverage against the fifteen reports requested

**Built: 11.** Customer Journey & Lifecycle · Segmentation · Repeat Purchase
Rate · Returning vs New · Retention Metrics · Purchase Behaviour · Abandoned
Checkout · Abandoned Cart (checkout stage) · Conversion Funnel · Acquisition &
Retention · Store Credit Usage.

**Outside Shopify: 3.** Loyalty Program Performance · Revenue from Loyalty ·
Rewards Redemption. Shopify has no native loyalty programme; Worood uses
Smile.io, which has its own API, its own key and its own customer identifiers.
A separate integration, not an extension of this one.

**Partial: 1.** Abandoned Cart covers the checkout stage — the only one with a
reachable person attached. Shopify's `Abandonment` object also tracks abandoning
while browsing and while adding to cart; `sd_abandoned_checkouts.stage` exists
for those.

---

## 10. Files

**Migrations:** `0010` customer derived columns · `0011` abandoned checkouts ·
`0012` store credit · `0013` customer soft delete · `0014` customer stats rebuild

**New services:** `backfill.service.ts` · `scheduler.service.ts` ·
`abandoned-checkout.service.ts` · `store-credit.service.ts` ·
`customer-metrics.service.ts` · `webhooks/topics.ts`

**Operational endpoints**, all behind `sales.sync.manage`:

```
GET  /sales/admin/sync                     watermarks, last runs, queue depth
GET  /sales/admin/sync/diagnostics         source, token, Redis, live ping, granted scopes
GET  /sales/admin/sync/reconcile-check     three-way comparison for one day
GET  /sales/admin/sync/schema?types=A,B    introspect the live GraphQL schema
POST /sales/admin/sync/backfill            bulk order import
POST /sales/admin/sync/reconcile           delta pull now
POST /sales/admin/sync/snapshots           ShopifyQL capture now
POST /sales/admin/sync/abandoned           abandoned checkout pull now
POST /sales/admin/sync/store-credit        store credit export now
POST /sales/admin/sync/shop                re-read currency and timezone
POST /sales/admin/sync/webhooks/register   register subscriptions
POST /sales/admin/sync/webhooks/verify     run the watchdog now
POST /sales/admin/sync/retention           trim payloads and PII now
```

---

## 11. Operational notes

`SHOPIFY_SCHEDULE_ENABLED=false` opts out of all scheduled work — worth setting
when two machines point at the same store, since both would otherwise reconcile
and spend the rate-limit budget twice for one set of numbers.

Locally, Redis must be started after each Windows restart
(`wsl -d Ubuntu -e sudo service redis-server start`), and the ngrok URL changes
on restart — `.env` and the subscriptions both need updating, since
subscriptions pointing at a dead address are deleted by Shopify after eight
failures.

The API version is pinned at `2026-07`. Versions ship quarterly and are
supported at least twelve months, so the standing task is one version bump per
quarter — **including re-registering the webhook subscriptions**, which are
pinned to the version they were created with and do not advance on their own.