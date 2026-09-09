-- 0010_customer_derived_columns.sql
-- Fill in two customer columns that nothing has ever written.
--
-- `sd_customers.first_order_at` and `sd_customers.total_spent` were created in
-- 0003 and have been NULL and 0 on every row since. The customer upsert writes
-- `orders_count` and `last_order_at` and nothing else, so the columns existed
-- without ever being populated -- which is invisible until something reads
-- them. The Customer Insights widgets read them, and returned 0% returning
-- customers, EGP 0 of repeat revenue, and an empty cohort table on a store with
-- 92,944 orders and 37,484 customers.
--
-- Neither needs anything from Shopify. Both are derived from orders already
-- mirrored: the first order's timestamp, and the sum of what was collected.
--
-- `total_spent` uses net_payment rather than total_price on purpose. This is a
-- cash-on-delivery store: total_price is what was ordered, net_payment is what
-- came back. "Lifetime spend" should mean money the business actually received,
-- or a customer who orders constantly and refuses at the door looks like the
-- best customer on the list.
--
-- Cancelled, test and deleted orders are excluded, matching every other
-- customer figure in the module. Guest orders have no customer to attribute to.

UPDATE sd_customers c
   SET first_order_at = agg.first_at,
       total_spent    = agg.spent
  FROM (
    SELECT o.customer_id,
           MIN(o.shopify_created_at)          AS first_at,
           COALESCE(SUM(o.net_payment), 0)    AS spent
      FROM sd_orders o
     WHERE o.customer_id IS NOT NULL
       AND o.test = false
       AND o.cancelled_at IS NULL
       AND o.deleted_at IS NULL
     GROUP BY o.customer_id
  ) AS agg
 WHERE c.id = agg.customer_id;

-- Cohorts group by first_order_at and the widgets filter on it, so it is worth
-- an index at 37,000 rows and more worth one as the store grows.
CREATE INDEX IF NOT EXISTS sd_customers_first_order_idx
  ON sd_customers (shop_id, first_order_at);

-- Ranking by lifetime spend is the top-customers table's only sort.
CREATE INDEX IF NOT EXISTS sd_customers_spend_idx
  ON sd_customers (shop_id, total_spent DESC);