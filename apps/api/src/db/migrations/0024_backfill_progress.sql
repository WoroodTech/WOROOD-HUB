-- 0024_backfill_progress.sql
-- Where a backfill got to, so an interrupted one can carry on.
--
-- An import of a store's whole order history is minutes of streaming and tens
-- of thousands of writes. Until now none of that was recorded until it had all
-- finished: a deploy, an OOM kill or a dropped connection halfway through left
-- a partly-populated mirror, no record that anything had been attempted, and a
-- restart that began again from the first order.
--
-- One jsonb column rather than six typed ones, because this is a progress note
-- for one job rather than something queried across rows -- nothing filters or
-- joins on it, and its shape will change as the import does.
--
--   { operationId, url, urlExpiresAt, linesProcessed, ordersWritten,
--     objectCount, startedAt, phase }
--
-- Null for every resource that is not a backfill, which is all of them.

ALTER TABLE sd_sync_state ADD COLUMN IF NOT EXISTS progress jsonb;

COMMENT ON COLUMN sd_sync_state.progress IS
  'Progress of a long-running import, for resumption. Null unless a backfill is in flight or was interrupted.';