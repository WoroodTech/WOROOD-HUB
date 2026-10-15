-- 0023_webhook_event_lifecycle.sql
-- A lifecycle a worker can actually be run against.
--
-- The table already records what happened to an event -- PENDING, PROCESSED,
-- STALE, FAILED -- but not what should happen next, and that is the gap. There
-- is nowhere to say when a failure may be tried again, nothing to say which
-- worker holds an event or until when, and no way to tell a failure that is
-- worth retrying from one that has exhausted its attempts. Without those, two
-- workers would take the same event, a crash would strand it in an unrecorded
-- state for ever, and a permanently broken payload would be retried until the
-- end of time.
--
-- No existing row changes status. The four states in use keep their meaning;
-- PROCESSING and DEAD are added beside them.
--
--   PENDING     accepted, waiting to be claimed
--   PROCESSING  claimed by a worker, lease held until lease_expires_at
--   PROCESSED   terminal: applied
--   STALE       terminal: superseded by newer data; not an error
--   FAILED      an attempt failed; eligible again at next_attempt_at
--   DEAD        terminal: attempts exhausted, needs a person
--
-- The worker itself is not part of this migration.

/* ----------------------------------------- columns, and a one-time backfill -- */

-- Wrapped together, and guarded, because the backfill below must happen exactly
-- once.
--
-- The runner refuses a file whose checksum changed, so this will not normally
-- run twice -- but "normally" is not a safety property. A restored database, a
-- hand-run file, a rebuilt migrations table: any of these replays it, and the
-- backfill is destructive on replay. It sets every FAILED row's next_attempt_at
-- to NULL, which after Phase 4 is where live retry schedules live. Running it
-- again would unschedule every pending retry in the system and leave them
-- waiting for a person who does not know to look.
--
-- The guard is the column itself. Each migration runs inside BEGIN/COMMIT, so a
-- failure rolls back the ADD COLUMN with everything else: the column exists if
-- and only if this migration has already completed. Nothing else needs to be
-- consulted, and no bookkeeping table is involved.
DO $$
DECLARE first_run boolean;
BEGIN
  first_run := NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sd_webhook_events' AND column_name = 'next_attempt_at');

  -- When this event may next be claimed.
  --
  -- The retry clock. Defaulted to now() so an event is claimable the moment it
  -- is accepted, which means the ingest INSERT does not have to mention it and
  -- is left exactly as it is.
  ALTER TABLE sd_webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz DEFAULT now();

  -- When the last attempt was made.
  --
  -- processed_at is only written on a terminal outcome, so a row that has
  -- failed twice and is waiting to be tried again carries no timestamp at all
  -- -- the error text, and no indication of when it was produced.
  ALTER TABLE sd_webhook_events ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

  -- Who holds this event, and until when.
  --
  -- A claim has to expire. A worker killed between claiming an event and
  -- finishing it leaves the row PROCESSING for ever, and an event nobody will
  -- ever finish is worse than one nobody has started: it is invisible to every
  -- backlog count and looks like success. The expiry is what lets another
  -- worker take it back without a human deciding it is safe.
  --
  -- The owner is recorded so a stalled host can be identified, and so that
  -- completion can be made conditional on still holding the claim. See
  -- webhook-lifecycle.ts.
  ALTER TABLE sd_webhook_events ADD COLUMN IF NOT EXISTS lease_owner text;
  ALTER TABLE sd_webhook_events ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

  IF first_run THEN
    -- Events already accepted but never processed stay claimable.
    --
    -- These are genuinely outstanding work -- accepted, enqueued in Redis, and
    -- lost when the process that was going to handle them went away. Scheduled
    -- from received_at rather than now() so they keep their place ahead of new
    -- arrivals, which is the order they should have been done in.
    --
    -- Unconditional on status rather than on next_attempt_at being null: adding
    -- a column with a default fills every existing row with that default, so by
    -- the time this runs they all read now().
    UPDATE sd_webhook_events
       SET next_attempt_at = received_at
     WHERE status = 'PENDING';

    -- Failures from before this migration are NOT rescheduled.
    --
    -- Nothing has ever retried them, so in practice they are already terminal,
    -- and some are old enough that the retention job has nulled their payload
    -- -- there is nothing left to replay. Sweeping them into a worker's first
    -- run would produce a burst of attempts that mostly cannot succeed, and
    -- would bury the live backlog underneath it.
    --
    -- A null next_attempt_at means unscheduled: the claim predicate ignores it,
    -- the row stays visible and countable, and Phase 8's replay can reschedule
    -- it deliberately. The status is left as FAILED because that is what
    -- happened.
    UPDATE sd_webhook_events
       SET next_attempt_at = NULL
     WHERE status = 'FAILED';

    -- Terminal rows have no next attempt, and the column should not imply they
    -- do. They are already outside every claim predicate; this is so a person
    -- reading the table is not told a processed event is due in a minute.
    UPDATE sd_webhook_events
       SET next_attempt_at = NULL
     WHERE status IN ('PROCESSED','STALE','DEAD');
  END IF;
END $$;

/* ------------------------------------------------------------ the states -- */

-- Added NOT VALID on purpose.
--
-- The column has never had a constraint, and this migration runs against a
-- production table whose complete contents cannot be inspected from here. A
-- validating constraint would abort the deploy on a single unexpected value --
-- and the instruction is to preserve every existing record, not to discover at
-- deploy time that one of them is unusual.
--
-- NOT VALID enforces the rule on every insert and update from now on while
-- leaving existing rows untouched. Once the table has been checked, the
-- constraint can be promoted without blocking writes:
--
--   SELECT status, count(*) FROM sd_webhook_events GROUP BY status;
--   ALTER TABLE sd_webhook_events VALIDATE CONSTRAINT sd_webhook_events_status_check;
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sd_webhook_events_status_check') THEN
    ALTER TABLE sd_webhook_events ADD CONSTRAINT sd_webhook_events_status_check
      CHECK (status IN ('PENDING','PROCESSING','PROCESSED','STALE','FAILED','DEAD')) NOT VALID;
  END IF;
END $$;

-- A claim is a lease or it is nothing.
--
-- PROCESSING without an expiry is the stranded row this whole migration exists
-- to prevent, so the database refuses to represent it. Also NOT VALID: no row
-- can currently be PROCESSING, since the status is new, but the same
-- deploy-safety argument applies to anything unexpected already stored.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sd_webhook_events_lease_check') THEN
    ALTER TABLE sd_webhook_events ADD CONSTRAINT sd_webhook_events_lease_check
      CHECK (status <> 'PROCESSING' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
      NOT VALID;
  END IF;
END $$;

/* ---------------------------------------------------------------- indexes -- */

-- The old index goes either way: dropping one is a catalogue change and an
-- unlink, fast enough that the brief ACCESS EXCLUSIVE it takes is not worth
-- deferring. It selects the same rows the claim index does, without the
-- ordering a claim needs, and nothing in the codebase reads it -- verified
-- across every query against this table. Two partial indexes over the same
-- predicate is write amplification on the hottest table in the module.
DROP INDEX IF EXISTS sd_webhook_events_pending_idx;

-- Building the new ones is the part that can block.
--
-- Plain CREATE INDEX holds a SHARE lock for the length of the build, and writes
-- to this table are live Shopify deliveries -- a blocked ingest is a delivery
-- Shopify retries. CONCURRENTLY avoids that but cannot run inside a
-- transaction, and the runner wraps every migration in BEGIN/COMMIT, so it
-- cannot be written here.
--
-- Nor can the build be moved ahead of the deploy: these indexes are on columns
-- this migration adds, so there is nothing to index until it has run.
--
-- So the size decides. On a small table the build is milliseconds and inline is
-- simplest -- and it is the only path that gives a fresh development or CI
-- database its indexes. Past the threshold the migration declines, says so, and
-- leaves the build to deploy/postgres/0023-indexes-concurrently.sql, run after
-- the deploy. Nothing needs these indexes until the Phase 4 worker exists, so
-- the gap between the two is harmless.
--
-- reltuples is the planner's estimate, not a count: a count of a large table is
-- itself a scan, and an estimate is the right precision for choosing between
-- "instant" and "worth doing carefully".
DO $$
DECLARE
  estimated_rows bigint;
  threshold      constant bigint := 200000;
BEGIN
  SELECT GREATEST(reltuples, 0)::bigint INTO estimated_rows
    FROM pg_class WHERE oid = 'sd_webhook_events'::regclass;

  IF estimated_rows < threshold THEN
    CREATE INDEX IF NOT EXISTS sd_webhook_events_claimable_idx
      ON sd_webhook_events (next_attempt_at, received_at)
      WHERE status IN ('PENDING','FAILED') AND next_attempt_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS sd_webhook_events_lease_idx
      ON sd_webhook_events (lease_expires_at)
      WHERE status = 'PROCESSING';

    CREATE INDEX IF NOT EXISTS sd_webhook_events_dead_idx
      ON sd_webhook_events (received_at DESC)
      WHERE status = 'DEAD';
  ELSE
    RAISE NOTICE
      'sd_webhook_events has about % rows: skipping inline index build to avoid blocking webhook ingest. Run deploy/postgres/0023-indexes-concurrently.sql after this deploy.',
      estimated_rows;
  END IF;
END $$;

COMMENT ON COLUMN sd_webhook_events.next_attempt_at IS
  'When the event may next be claimed. NULL means unscheduled: not picked up by the worker, awaiting a deliberate replay.';
COMMENT ON COLUMN sd_webhook_events.lease_owner IS
  'Identifier of the worker holding the claim. Diagnostic only; correctness comes from the conditional claim UPDATE.';
COMMENT ON COLUMN sd_webhook_events.lease_expires_at IS
  'When the claim lapses and the event may be taken over. Required while status is PROCESSING.';
COMMENT ON COLUMN sd_webhook_events.last_attempt_at IS
  'When the most recent attempt ran, including attempts that failed and are awaiting retry.';