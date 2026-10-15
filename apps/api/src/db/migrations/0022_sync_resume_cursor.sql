-- 0022_sync_resume_cursor.sql
-- Where an unfinished reconciliation run should carry on from.
--
-- Reconciliation reads orders in `updated_at` order and stops at a page
-- ceiling. Until now the only record of progress was the watermark, a
-- timestamp, and a timestamp cannot checkpoint inside a backlog that shares
-- one: a bulk edit gives thousands of orders the same `updated_at`, and the
-- resume point then never moves. The run fetches the same forty pages, writes
-- the same two thousand orders, and the tail is never reached -- not delayed,
-- never. The same happens, less obviously, whenever a backlog sits inside the
-- five-minute overlap that the next run subtracts before querying.
--
-- Shopify's own cursor is positional, so it resumes between two orders bearing
-- the same instant. It is only meaningful against the query that produced it,
-- so the `since` of that query is stored beside it and reissued on resume.
--
-- Both columns are null in the ordinary case -- a run that finished. Nothing
-- reads them unless a run stopped early, so existing rows need no backfill.

ALTER TABLE sd_sync_state ADD COLUMN IF NOT EXISTS resume_cursor text;
ALTER TABLE sd_sync_state ADD COLUMN IF NOT EXISTS resume_since timestamptz;

COMMENT ON COLUMN sd_sync_state.resume_cursor IS
  'Shopify end cursor of the last page durably written by an unfinished run. Null when the last run completed.';
COMMENT ON COLUMN sd_sync_state.resume_since IS
  'The `since` the resume_cursor was produced under. A cursor is only valid for the query that issued it.';