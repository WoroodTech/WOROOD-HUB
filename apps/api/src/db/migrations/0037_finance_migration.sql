-- 0037_finance_migration.sql
-- Bringing the spreadsheet's history across.
--
-- The rule this schema exists to enforce: **nothing from the sheet lands in the
-- live tables until it has been read, checked and looked at by a person.**
-- An import that writes straight into fin_requests cannot be inspected before
-- it is believed, and cannot be run twice to see whether it still says the
-- same thing.
--
-- So rows arrive in a staging table, keep the identity they had in the sheet,
-- and are promoted in a separate step. A batch can be imported, examined,
-- thrown away and imported again as many times as it takes.

CREATE TABLE fin_import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was loaded: 'requests', 'payments', 'notes', 'files'.
  kind          text NOT NULL,

  -- The file it came from, for tracing a row back to its source.
  source_name   text NOT NULL,

  -- PENDING  — loaded into staging, nothing promoted
  -- PROMOTED — written into the live tables
  -- DISCARDED— abandoned; staging rows kept for reference
  status        text NOT NULL DEFAULT 'PENDING',

  rows_read     integer NOT NULL DEFAULT 0,
  rows_valid    integer NOT NULL DEFAULT 0,
  rows_promoted integer NOT NULL DEFAULT 0,

  /* Everything that was wrong with the file, as a list a person can work
     through. Not an error that stops at the first bad row: a migration run
     that reports one problem at a time takes as many runs as there are
     problems. */
  problems      jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_by_id uuid REFERENCES core_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  promoted_at   timestamptz,

  CONSTRAINT fin_import_batches_kind_check
    CHECK (kind IN ('requests', 'payments', 'notes', 'files')),
  CONSTRAINT fin_import_batches_status_check
    CHECK (status IN ('PENDING', 'PROMOTED', 'DISCARDED'))
);

/* ------------------------------------------------------------ staging -- */

CREATE TABLE fin_import_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES fin_import_batches(id) ON DELETE CASCADE,

  -- The sheet's own identifier, column J. This is what makes the import
  -- repeatable: the same row read twice is the same request, not a second one.
  legacy_id     text NOT NULL,
  legacy_tab    text,

  -- The columns, as read. Kept as text so a malformed date or amount survives
  -- long enough to be reported rather than killing the read.
  raw           jsonb NOT NULL,

  -- What it resolved to, once matched against departments and people.
  department_id uuid REFERENCES core_departments(id),
  requester_id  uuid REFERENCES core_users(id),

  /* Null until promoted. ON DELETE SET NULL rather than RESTRICT: a staging
     row is a record of what an import did, and it must not be the reason a
     request cannot later be removed. The link going quiet is the correct
     outcome -- the request is gone, so there is nothing to point at. */
  request_id    uuid REFERENCES fin_requests(id) ON DELETE SET NULL,

  valid         boolean NOT NULL DEFAULT false,
  problems      jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The same sheet row must not become two requests, however many times a file
-- is imported. This is the constraint the whole repeatability rests on.
CREATE UNIQUE INDEX fin_import_requests_once
  ON fin_import_requests (legacy_id, batch_id);

CREATE INDEX fin_import_requests_batch_idx ON fin_import_requests (batch_id, valid);

CREATE TABLE fin_import_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES fin_import_batches(id) ON DELETE CASCADE,
  legacy_id     text NOT NULL,      -- the request's sheet id
  raw           jsonb NOT NULL,
  payment_id    uuid REFERENCES fin_payments(id) ON DELETE SET NULL,
  valid         boolean NOT NULL DEFAULT false,
  problems      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fin_import_payments_batch_idx ON fin_import_payments (batch_id, valid);

/* --------------------------------------------------- what came from where */
-- Every promoted row remembers its sheet identity, permanently.
--
-- Not for the migration's sake -- for the year afterwards. When somebody asks
-- why a figure differs from the old sheet, the answer needs the row it came
-- from, and a reconciliation that cannot name its sources is an assertion
-- rather than a check.

ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS legacy_id text;
ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS legacy_tab text;
ALTER TABLE fin_payments ADD COLUMN IF NOT EXISTS legacy_id text;

-- One live request per sheet row, enforced rather than hoped for: re-running a
-- promotion must update what is there, not add beside it.
CREATE UNIQUE INDEX fin_requests_legacy_once
  ON fin_requests (legacy_id) WHERE legacy_id IS NOT NULL;

COMMENT ON COLUMN fin_requests.legacy_id IS
  'The identifier this request had in the spreadsheet (column J). Null for '
  'anything raised in the portal.';