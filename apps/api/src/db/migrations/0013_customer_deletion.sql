-- 0013_customer_deletion.sql
-- A customer deleted in Shopify has to stop counting here.
--
-- Same shape of gap `orders/delete` had before 0008, and the same reasoning
-- applies twice over. `customers/delete` was not subscribed to, so Shopify
-- never reported it. And reconciliation cannot detect a deletion in principle:
-- it asks for records whose `updated_at` moved, and a deleted record simply
-- stops being returned. Absence is not an event a delta pull can observe.
--
-- The cost of missing it is larger here than it was for orders, because every
-- customer figure is a ratio over the customer base. A deleted customer keeps
-- inflating the denominator of repeat-purchase rate, keeps appearing in a
-- cohort, and keeps their lifetime spend in the top-customers table -- for a
-- person who asked to be removed. That last one matters beyond arithmetic.
--
-- Soft, like everywhere else: the row is the only remaining record and their
-- orders still have to resolve to something. The retention job is what clears
-- the identifying columns; this only stops them being counted.

ALTER TABLE sd_customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Nearly every customer read wants live rows only, and deletions are rare, so
-- the index is partial and stays close to the size of the table.
CREATE INDEX IF NOT EXISTS sd_customers_live_idx
  ON sd_customers (shop_id, last_order_at DESC)
  WHERE deleted_at IS NULL;