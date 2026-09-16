# Omnia's fifteen reports — what exists, what is named, what is missing

## The map

| # | Request | Widget key | Dashboard | Status |
|---|---|---|---|---|
| 1 | Loyalty Program Performance | — | — | Outside Shopify — Smile.io |
| 2 | Revenue from Loyalty Program | — | — | Outside Shopify — Smile.io |
| 3 | Customer Journey & Lifecycle | `kpi-time-to-second-order`<br>`bar-order-frequency` | Customer Insights | Built |
| 4 | Customer Segmentation | `donut-customer-segments` | Customer Insights | Built |
| 5 | Repeat Purchase Rate | `kpi-repeat-rate` | Customer Insights | Built |
| 6 | Returning vs New Customers | `kpi-new-vs-returning`<br>`donut-new-vs-returning` | Customer Insights | Built |
| 7 | Customer Retention Metrics | `table-cohort-retention` | Customer Insights | Built |
| 8 | Purchase Behavior & Trends | `bar-order-frequency`<br>`table-top-customers` | Customer Insights | Built |
| 9 | Rewards Redemption | — | — | Outside Shopify — Smile.io |
| 10 | Store Credit Usage | — | — | Unverified |
| 11 | Abandoned Checkout | `kpi-abandoned`<br>`kpi-abandoned-value`<br>`kpi-recovery-rate`<br>`kpi-recovered-value`<br>`chart-abandonment`<br>`table-open-checkouts` | Checkout Recovery | Built |
| 12 | Abandoned Cart | `donut-abandoned-age` | Checkout Recovery | Partial — see below |
| 13 | Conversion Funnel & Checkout | `funnel-conversion` | Marketing and Traffic | Pre-existing |
| 14 | Acquisition & Retention | `chart-acquisition`<br>`kpi-returning-revenue` | Customer Insights | Built |
| 15 | Additional customer analytics | `table-top-customers` | Customer Insights | Built |

**Eleven of fifteen answered.** Three sit outside Shopify entirely, one is
unverified.

## Files

| File | Goes to |
|---|---|
| `api/migrations/0010_customer_derived_columns.sql` | `apps/api/src/db/migrations/` **(new)** |
| `api/migrations/0011_abandoned_checkouts.sql` | `apps/api/src/db/migrations/` **(new)** |
| `api/metrics/customer-metrics.service.ts` | `apps/api/src/modules/sales-dashboard/metrics/` **(new)** |
| `api/sync/abandoned-checkout.service.ts` | `apps/api/src/modules/sales-dashboard/sync/` **(new)** |
| `api/metrics/metrics.service.ts` | `apps/api/src/modules/sales-dashboard/metrics/` |
| `api/sync/scheduler.service.ts` | `apps/api/src/modules/sales-dashboard/sync/` |
| `api/sync/sync.service.ts` | `apps/api/src/modules/sales-dashboard/sync/` |
| `api/module/sales-dashboard.module.ts` | `apps/api/src/modules/sales-dashboard/` |
| `api/db/seed.ts` | `apps/api/src/db/` |
| `web/widgets/WidgetCard.tsx` | `apps/web/src/widgets/` |
| `contract/web-contract.ts` | `apps/web/src/contract.ts` |
| `contract/api-contract.ts` | `apps/api/src/contract.ts` |
| `contract/packages-contract-index.ts` | `packages/contract/index.ts` |

```bash
cd apps/api
npm run migrate                                   # 0010 and 0011
npm run seed                                      # NOT --reset
npm run build && node dist/main.js
# then, once, to fill the table before waiting 30 minutes:
# POST /api/v1/sales/admin/sync/abandoned
```

## What "Abandoned Cart" partially means

Shopify's `abandonedCheckouts` query returns **checkouts** only — the stage
where contact details were entered. Its broader `Abandonment` object also
tracks abandoning while browsing and while adding to cart, which is the true
cart-versus-checkout split.

The table carries a `stage` column for that reason, defaulting to `CHECKOUT`.
Pulling the browse and cart stages is a further piece of work; what is built now
covers the checkout stage, which is the one with a reachable person attached.

`donut-abandoned-age` answers the practical half of the cart question — how
long things have been sitting — without needing the other stages.

## Why these numbers cannot be checked against the Shopify admin

Every widget in both new dashboards carries `computedLocally: true` and shows a
**"computed here"** badge.

Shopify computes cohort retention, RFM and repeat-purchase rate internally for
its own customer reports and does not expose them through `shopifyqlQuery`.
There is nothing to read, so they are derived from the 92,944 mirrored orders.
Abandonment figures are ours over our own retention window and will likewise not
match Shopify's report line for line.

A number that cannot be reconciled must not look like one that can, which is
what the badge is for.

## Verifying the customer figures

```sql
-- 0010 filled both columns
SELECT COUNT(*) AS total,
       COUNT(first_order_at) AS with_first_order,
       COUNT(*) FILTER (WHERE total_spent > 0) AS with_spend
  FROM sd_customers;

-- the counts close
SELECT COUNT(*) FILTER (WHERE orders_count = 1) AS one_order,
       COUNT(*) FILTER (WHERE orders_count > 1) AS repeat_c,
       COUNT(*) FILTER (WHERE orders_count = 0) AS zero,
       COUNT(*) AS total
  FROM sd_customers;

-- repeat rate matches the widget
SELECT COUNT(DISTINCT c.id) AS customers,
       COUNT(DISTINCT c.id) FILTER (WHERE c.orders_count > 1) AS repeat_c
  FROM sd_orders o JOIN sd_customers c ON c.id = o.customer_id
 WHERE o.test = false AND o.cancelled_at IS NULL AND o.deleted_at IS NULL
   AND o.shopify_created_at >= now() - interval '30 days';
```

`with_spend` will be far below the total: `total_spent` sums `net_payment`, and
most cash-on-delivery orders sit at zero collected. That is correct.

On the cohort table, a cohort too young for a column shows a dash, not a zero —
the window has not elapsed, which is not the same as nobody returning. And the
columns must not decrease left to right: `≤1 month` ≤ `≤3` ≤ `≤6` ≤ `≤12`.

## Still open

**Loyalty — Smile.io.** Not impossible, as previously stated, but a separate
integration: Smile.io has its own API with its own key, its own tables, and a
mapping between Smile customers and Shopify customers. Nothing about it extends
the Shopify work. Points, tiers and redemptions all live there.

**Store credit.** `storeCreditAccount` exists on the customer object; whether it
exposes a transaction history or only a current balance is unverified. Worth an
introspection query before promising a usage report.

**Browse and cart abandonment stages**, per above.

**Customer Care still cannot open either dashboard** unless the role gains
`sales.dashboard.view`. Both are granted to Marketing, Executive and — for
Checkout Recovery — Operations.