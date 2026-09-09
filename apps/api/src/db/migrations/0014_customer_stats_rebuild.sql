-- 0014_customer_stats_rebuild.sql
-- Rebuild the customer statistics on one consistent basis.
--
-- Three columns feed every Customer Insights figure, and two of them were
-- being written from a different source than the one the figures filter on.
--
-- `orders_count` was Shopify's `numberOfOrders`, copied in whenever a webhook
-- payload happened to carry the customer object. Shopify counts on its own
-- basis; every figure here excludes test, cancelled and deleted orders. So the
-- repeat-purchase rate was dividing one basis by another. And because
-- cancelling an order does not send a customer update, the count never came
-- back down.
--
-- `first_order_at` was a running LEAST of every order date seen. If the
-- earliest order was later cancelled or deleted, the column kept pointing at
-- it -- and new-versus-returning classifies each order against exactly that
-- date, so one cancellation could reclassify a customer's entire history.
--
-- From now on all three are recomputed from `sd_orders` after every batch, on
-- the same filters the reports use. This migration brings the existing 37,484
-- rows onto that basis; without it the columns stay as they were until each
-- customer happens to be touched by a new order.

UPDATE sd_customers c
   SET total_spent    = agg.spent,
       orders_count   = agg.orders,
       first_order_at = agg.first_at,
       last_order_at  = agg.last_at
  FROM (
    SELECT o.customer_id,
           COALESCE(SUM(o.net_payment), 0) AS spent,
           COUNT(*)                        AS orders,
           MIN(o.shopify_created_at)       AS first_at,
           MAX(o.shopify_created_at)       AS last_at
      FROM sd_orders o
     WHERE o.customer_id IS NOT NULL
       AND o.test = false
       AND o.cancelled_at IS NULL
       AND o.deleted_at IS NULL
     GROUP BY o.customer_id
  ) AS agg
 WHERE c.id = agg.customer_id;

-- Customers whose every order was cancelled, deleted or is a test drop out of
-- the group above, so the UPDATE never reaches them. Zeroed explicitly: the one
-- case where the count should certainly be nought is otherwise the one case
-- that never changes.
UPDATE sd_customers c
   SET total_spent = 0, orders_count = 0, first_order_at = NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM sd_orders o
    WHERE o.customer_id = c.id
      AND o.test = false AND o.cancelled_at IS NULL AND o.deleted_at IS NULL);