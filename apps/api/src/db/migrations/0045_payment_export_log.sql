-- 0045_payment_export_log.sql
-- What has already been handed to the accountant.
--
-- The export is incremental: each one picks up where the last left off, so a
-- reference is given out once and none is missed. That needs a record of
-- where the last one stopped, and it has to survive a restart.
--
-- **Shared, not per person.** The point is reconciliation, not a personal
-- download history: if one person in Finance exports in the morning and
-- somebody else exports after lunch, the second must not hand over the same
-- references again. A per-user mark would do exactly that.

CREATE TABLE sd_payment_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  exported_by uuid REFERENCES core_users(id),
  exported_at timestamptz NOT NULL DEFAULT now(),

  -- The window this export covered. `through` is what the next one starts
  -- from, so the two are stored rather than recomputed: a later change to the
  -- default window must not move the boundary of an export already handed
  -- over.
  covers_from timestamptz NOT NULL,
  covers_to   timestamptz NOT NULL,

  rows        integer NOT NULL DEFAULT 0,
  format      text NOT NULL DEFAULT 'csv',

  CONSTRAINT sd_payment_exports_window CHECK (covers_to >= covers_from)
);

CREATE INDEX sd_payment_exports_recent_idx
  ON sd_payment_exports (exported_at DESC);

/* ----------------------------------------------------------- who may -- */
-- The same permission that shows the references on screen. Somebody who can
-- read them one row at a time can have them as a file; somebody who cannot
-- should not get them by another route.
--
-- Nothing is inserted here: `sales.order.payment.view` already exists from
-- 0043 and is already held by finance and admin.