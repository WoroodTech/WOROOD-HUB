-- 0040_finance_sheet_sync.sql
-- Writing requests through to the accountant's spreadsheet.
--
-- The sheet stays after the migration: the accountant works in it for things
-- the portal has nothing to do with, and the request log is only one part of
-- it. So requests raised in the portal have to appear there the way they did
-- when the Apps Script was raising them.
--
-- **What is written, and what is not.** Rows are appended to the department's
-- own Log tab -- Marketing Log, Purchases Log and the rest. Nothing is written
-- to Local Cash Flow, because the columns there that count request spending
-- are SUMPRODUCT formulas reading those same Log tabs. Writing a number into
-- one would replace the formula with a constant, and every request after it
-- would stop being counted -- silently, and not noticeably until the figures
-- had been wrong for weeks.
--
-- Queued rather than written inline, for the reason the Zoho queue exists: a
-- person pressing Submit should not wait on Google, and Google being
-- unreachable for ten minutes should not lose anything.

CREATE TABLE fin_sheet_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ROW_UPSERT — put this request's row in its Log tab, adding or updating.
  kind            text NOT NULL DEFAULT 'ROW_UPSERT',

  request_id      uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,

  /* The row as it should appear, built when the event was queued. Kept rather
     than rebuilt at send time so a retry writes what was meant at the moment
     something happened, not whatever the request looks like by the time the
     queue drains. */
  payload         jsonb NOT NULL,

  -- Which tab, decided from the department when the event is queued.
  tab             text NOT NULL,

  status          text NOT NULL DEFAULT 'PENDING',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,

  -- Claimed with FOR UPDATE SKIP LOCKED, so two workers never take one row.
  lease_owner     text,
  lease_expires_at timestamptz,

  -- Where it landed, for tracing a row back from the sheet.
  sheet_row       integer,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  written_at      timestamptz,

  CONSTRAINT fin_sheet_events_status_check
    CHECK (status IN ('PENDING', 'SENDING', 'WRITTEN', 'FAILED', 'DEAD', 'SUPERSEDED'))
);

/*
 * One pending event per request.
 *
 * A request that is created, approved and then paid within a minute would
 * otherwise queue three events writing to the same row, and they would race:
 * the worker could write the "approved" state after the "paid" one and leave
 * the sheet showing a request as unpaid when it is not.
 *
 * Instead the newest event supersedes the one before it -- the payload is
 * rebuilt from the request as it now stands -- so exactly one write happens
 * and it carries the current truth.
 *
 * FAILED is in here too, and that matters: a failed event is still an event
 * waiting to happen. Covering only PENDING and SENDING would let a new event
 * be queued beside one that had failed, and the older of the two could be
 * retried last and overwrite the newer state.
 */
CREATE UNIQUE INDEX fin_sheet_events_one_pending
  ON fin_sheet_events (request_id)
  WHERE status IN ('PENDING', 'SENDING', 'FAILED');

CREATE INDEX fin_sheet_events_due_idx
  ON fin_sheet_events (next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

/* ------------------------------------------------- where the row landed -- */
-- Remembered on the request, so an update finds its row without scanning the
-- whole tab every time.
--
-- It is a hint, never a certainty: the accountant can sort, filter or delete
-- rows, and a row number means nothing a minute after it was recorded. The
-- worker confirms the ID still matches before writing, and searches for it
-- again when it does not. Without the hint every update would read a thousand
-- rows; with it, that happens only when something moved.

ALTER TABLE fin_requests
  ADD COLUMN IF NOT EXISTS sheet_row integer,
  ADD COLUMN IF NOT EXISTS sheet_tab text,
  ADD COLUMN IF NOT EXISTS sheet_written_at timestamptz;

COMMENT ON COLUMN fin_requests.sheet_row IS
  'Where this request''s row was last seen in its Log tab. A hint for finding '
  'it again, not a fact: rows move when the sheet is sorted. Always confirmed '
  'against the ID column before anything is written.';