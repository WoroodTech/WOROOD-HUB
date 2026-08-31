-- 0008_sales_order_deletion.sql
-- An order deleted in the Shopify admin has to be able to disappear here too.
--
-- Until now it could not. `sd_orders` had no way to represent a removed order,
-- and nothing was subscribed to `orders/delete`, so a deletion in Shopify left
-- the row in the mirror permanently -- counted in the orders table, counted in
-- the collected and outstanding totals, and impossible to remove except by
-- hand.
--
-- Reconciliation cannot fix this on its own and never could: it asks Shopify
-- for orders whose `updated_at` has moved, and a deleted order simply stops
-- being returned. Absence is not an event a delta pull can observe. The webhook
-- is the only mechanism that carries the fact, which is why the topic is now
-- registered alongside the other seven.
--
-- Soft rather than hard, for the same reason a retired meeting room is soft
-- deleted: the row is the only remaining record. Shopify will not serve the
-- order again, and any figure computed before the deletion still has to
-- resolve to something. Read paths filter on deleted_at IS NULL.

ALTER TABLE sd_orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Nearly every read wants live orders only, and the mirror is expected to be
-- almost entirely live, so the index is partial: it stays small and it is the
-- one the list and totals queries can use.
CREATE INDEX IF NOT EXISTS sd_orders_live_idx
  ON sd_orders (shop_id, shopify_created_at DESC)
  WHERE deleted_at IS NULL;