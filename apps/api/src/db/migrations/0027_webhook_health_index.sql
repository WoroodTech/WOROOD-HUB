-- 0027_webhook_health_index.sql
-- An index for the health screen's own questions.
--
-- The health endpoint counts events received in the last twenty-four hours and
-- how many of those were stale. On a table that holds every webhook the shop
-- has ever received, that is a sequential scan -- on a page that an operator
-- refreshes while they are worried about something, which is exactly when the
-- database is already busy.
--
-- Phase 8 adds more of the same shape: how many are waiting, retrying, dead,
-- and how many finished in the window. All of them are bounded by received_at.
--
-- Descending because every one of these queries asks about the recent end.

DO $$
DECLARE
  estimated_rows bigint;
  threshold      constant bigint := 200000;
BEGIN
  SELECT GREATEST(reltuples, 0)::bigint INTO estimated_rows
    FROM pg_class WHERE oid = 'sd_webhook_events'::regclass;

  IF estimated_rows < threshold THEN
    CREATE INDEX IF NOT EXISTS sd_webhook_events_received_idx
      ON sd_webhook_events (received_at DESC);
  ELSE
    -- Same reasoning as 0023: a plain build holds a SHARE lock, and writes to
    -- this table are live Shopify deliveries.
    RAISE NOTICE
      'sd_webhook_events has about % rows: skipping inline index build. Run: CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_webhook_events_received_idx ON sd_webhook_events (received_at DESC);',
      estimated_rows;
  END IF;
END $$;