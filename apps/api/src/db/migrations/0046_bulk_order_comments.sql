-- 0046_bulk_order_comments.sql
-- One comment, put on many orders.
--
-- **Why this is a job and not a request.** Each order means a write to
-- Shopify, and Shopify takes about two a second. Five hundred orders is four
-- minutes of calls -- longer than any browser will hold a request open, and
-- longer than most proxies allow. Run inside the request it would time out
-- somewhere in the middle, with no record of how far it got and no way to
-- finish the rest.
--
-- So the upload returns at once and the work happens behind it. The page
-- watches the counters and the person can close the tab.

CREATE TABLE sd_bulk_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  author_id     uuid NOT NULL REFERENCES core_users(id),
  body          text NOT NULL,

  status        text NOT NULL DEFAULT 'CHECKING',

  -- Filled while checking, so the screen can show progress against a total
  -- rather than a spinner with no end in sight.
  total         integer NOT NULL DEFAULT 0,
  published     integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,

  -- Why the whole run was refused before anything was published: a reference
  -- that matches no order, more than the ceiling, an unreadable file.
  refused_reason text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  CONSTRAINT sd_bulk_comments_status_check CHECK (
    status IN ('CHECKING', 'REFUSED', 'RUNNING', 'DONE', 'CANCELLED')
  )
);

CREATE INDEX sd_bulk_comments_recent_idx
  ON sd_bulk_comments (created_at DESC);

-- One row per order in the run.
--
-- Written during the check, before anything is published, so the run already
-- knows every order it will touch. A crash halfway through leaves this table
-- saying exactly which ones were done, and the rest can be picked up without
-- commenting on anything twice.
CREATE TABLE sd_bulk_comment_targets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES sd_bulk_comments(id) ON DELETE CASCADE,

  -- The reference exactly as the file had it, so an error names what the
  -- person typed rather than what we made of it.
  reference   text NOT NULL,
  order_id    uuid REFERENCES sd_orders(id),

  status      text NOT NULL DEFAULT 'PENDING',
  error       text,
  done_at     timestamptz,

  CONSTRAINT sd_bulk_comment_targets_status_check CHECK (
    status IN ('PENDING', 'PUBLISHED', 'FAILED')
  )
);

-- The worker claims in this order, and the page reads failures from it.
CREATE INDEX sd_bulk_comment_targets_pending_idx
  ON sd_bulk_comment_targets (run_id, status);

-- A reference appears once per run. A file with the same order twice would
-- otherwise put the comment on it twice, which cannot be undone from here.
CREATE UNIQUE INDEX sd_bulk_comment_targets_unique
  ON sd_bulk_comment_targets (run_id, reference);

/* ------------------------------------------------------ who may run -- */
-- The same permission as writing one note. Somebody who may comment on an
-- order may comment on five hundred; somebody who may not should not get
-- there through a file upload.
--
-- Nothing inserted: `sales.order.note.write` exists from 0041.