-- 0009_sales_order_number_bigint.sql
-- The order number needs more than an int4.
--
-- `sd_orders.order_number` was `integer`, which tops out at 2,147,483,647. The
-- column is derived by stripping non-digits from Shopify's order *name*, and on
-- the fixture store those names were `#1001` and friends, so four bytes was
-- plainly enough.
--
-- The real Worood store has order names whose digits run to ten characters --
-- `8970989710` was the one that stopped a 92,438-order backfill part-way
-- through, after the bulk export had already downloaded and reassembled
-- 244,987 JSONL lines. Long numeric order names are ordinary on a store that
-- migrated from another platform or uses a numbering suffix; the fixture simply
-- had none.
--
-- bigint rather than text, because the column is genuinely a number and is
-- sorted as one. Nothing reads it as a string.
--
-- Note this cannot rescue rows that were skipped by the failed run. Re-run the
-- backfill after applying it; the upsert is keyed on shopify_gid, so orders
-- already written are updated rather than duplicated.

ALTER TABLE sd_orders
  ALTER COLUMN order_number TYPE bigint USING order_number::bigint;