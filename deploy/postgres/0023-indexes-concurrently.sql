-- Optional pre-deploy step for migration 0023, for a large sd_webhook_events.
--
--   psql "$DATABASE_URL" -f deploy/postgres/0023-indexes-concurrently.sql
--
-- Run this AFTER the release containing 0023 has been deployed.
--
-- Not before: these indexes are on columns that migration adds, so there is
-- nothing to index until it has run. The migration itself builds them inline
-- when the table is small, and declines with a NOTICE when it is large --
-- that NOTICE is what sends you here. Nothing needs these indexes until the
-- Phase 4 worker exists, so running this minutes or hours later is fine.
--
-- Why this file exists rather than being part of the migration: the runner
-- wraps each migration in BEGIN/COMMIT, and CONCURRENTLY cannot run inside a
-- transaction. Plain CREATE INDEX takes a SHARE lock, which blocks writes to
-- sd_webhook_events -- and writes to that table are live Shopify deliveries. A
-- blocked ingest is a delivery Shopify retries.
--
-- Deliberately NOT in src/db/migrations: the runner executes every .sql file in
-- that directory, which would put these statements straight back inside a
-- transaction.
--
-- Safe to run more than once, and unnecessary on a small table, where the
-- migration will already have built them.
--
-- Decide with:
--   SELECT count(*) FROM sd_webhook_events;
--   SELECT pg_size_pretty(pg_total_relation_size('sd_webhook_events'));
--
-- Rough guide: below a few hundred thousand rows the plain build in the
-- migration takes under a second and the pre-step is not worth the ceremony.
--
-- Each statement runs in its own implicit transaction. If one is interrupted it
-- leaves an INVALID index behind -- a complete index entry that the planner
-- refuses to use. The checks below refuse to continue in that case rather than
-- papering over it, for a reason worth stating: CREATE INDEX CONCURRENTLY IF
-- NOT EXISTS matches on the NAME alone. Against an invalid index it reports
-- "already exists, skipping" and returns success, leaving the index invalid
-- for good. A rerun would look like it worked and change nothing.

\set ON_ERROR_STOP on

-- Refuse to run before the migration that adds the columns.
--
-- Every index below is on a column migration 0023 creates. Run too early this
-- script fails with "column does not exist" partway through, having possibly
-- built some of them; this says so first instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sd_webhook_events' AND column_name = 'next_attempt_at'
  ) THEN
    RAISE EXCEPTION
      'migration 0023 has not been applied: sd_webhook_events.next_attempt_at does not exist. Deploy the release containing it first.';
  END IF;
END $$;

-- Refuse to run with an invalid index left over from an interrupted attempt.
--
-- Named explicitly rather than cleaned up automatically: dropping an index is
-- a decision, and if one of these is invalid somebody should know why before
-- the next build starts.
DO $$
DECLARE stale text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO stale
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE NOT i.indisvalid
     AND c.relname IN ('sd_webhook_events_claimable_idx',
                       'sd_webhook_events_lease_idx',
                       'sd_webhook_events_dead_idx');
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION
      'invalid index left by an interrupted build: %. Drop it and re-run: DROP INDEX CONCURRENTLY %;',
      stale, stale;
  END IF;
END $$;

-- The claim query: the oldest event that is due.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_webhook_events_claimable_idx
  ON sd_webhook_events (next_attempt_at, received_at)
  WHERE status IN ('PENDING','FAILED') AND next_attempt_at IS NOT NULL;

-- Recovering abandoned work: leases that have run out.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_webhook_events_lease_idx
  ON sd_webhook_events (lease_expires_at)
  WHERE status = 'PROCESSING';

-- The dead-letter view, read by the failed-event screen.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_webhook_events_dead_idx
  ON sd_webhook_events (received_at DESC)
  WHERE status = 'DEAD';

-- The superseded index is dropped by the migration itself; a drop is a
-- catalogue change and an unlink, not a build, so it does not need deferring.
-- This statement is here only for a database where the migration's drop was
-- rolled back with a failed deploy.
DROP INDEX CONCURRENTLY IF EXISTS sd_webhook_events_pending_idx;