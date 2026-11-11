-- 0047_warehouse_core.sql
-- The Warehouse module: permissions, the write queue, and the read cache.
--
-- The spreadsheet stays the source of truth, as it is for Finance. HUB reads
-- the catalogue, the balances and the registers from it, and every movement
-- posted here is written back to it. Nothing about stock lives only in this
-- database.
--
-- What is here, then, is the two things the sheet cannot do: a queue that
-- survives a restart, and a cache so a page load does not re-read thirty
-- thousand rows.

/* ===================================================== permissions === */
-- Eleven permissions on the roles that already exist, rather than the eleven
-- roles the Apps Script carries. A role is a job; a permission is a thing you
-- may do. Mapping Workshop Cutting and Workshop Production onto roles here
-- would mean two more roles that differ by one action each.
--
-- Allow-list throughout: an action nobody has been granted is closed. The
-- Apps Script's gate_() deny-lists two roles, which is how an action added
-- later can be reachable by a role never meant to have it.

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('warehouse.view',            'warehouse', 'Open the warehouse module and see the item catalogue'),
  ('warehouse.stock.view',      'warehouse', 'See balances across warehouses and open an item card'),
  ('warehouse.tx.write',        'warehouse', 'Post a stock movement'),
  ('warehouse.tx.manage',       'warehouse', 'Post Open Balance and Shortage & Over, and edit or delete directly'),
  ('warehouse.approval.decide', 'warehouse', 'Decide an edit or delete request'),
  ('warehouse.item.manage',     'warehouse', 'Create an item and edit its details'),
  ('warehouse.rolls.view',      'warehouse', 'See the rolls register and job orders'),
  ('warehouse.rolls.receive',   'warehouse', 'Receive, issue, deliver and reconcile rolls'),
  ('warehouse.rolls.plan',      'warehouse', 'Plan and prioritise rolls'),
  ('warehouse.rolls.report',    'warehouse', 'Report production from the workshop'),
  ('warehouse.qc.handle',       'warehouse', 'Run the quality-check chain of custody'),
  ('warehouse.returns.handle',  'warehouse', 'Log and resolve return issues'),
  ('warehouse.report.view',     'warehouse', 'Run movement, top-seller and demand reports')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, description = EXCLUDED.description;

-- Granted to admin only, here. Everything else is given deliberately from the
-- Roles screen, because who runs the warehouse is a decision for Worood and
-- not something a migration should assume.
--
-- Not done through seed.ts: that file cannot be run on a live database -- it
-- deletes every role's permissions before re-inserting them, reverting every
-- grant made by hand since launch.
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r
  CROSS JOIN core_permissions p
 WHERE r.key = 'admin'
   AND p.module_key = 'warehouse'
ON CONFLICT DO NOTHING;

/* ==================================================== write queue === */
-- Every movement posted in HUB lands here first, then goes to the sheet.
--
-- A queue rather than a direct write, because the sheet can be slow, locked
-- by somebody editing it, or briefly unreachable -- and none of those should
-- lose a movement somebody has already been told was saved.

CREATE TABLE wh_sheet_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What this writes: a ledger row, an item, a roll event. The tab it lands
  -- on is decided from this, not stored, so a tab rename is one code change.
  kind            text NOT NULL,
  -- The thing in HUB this came from, so a row can be traced back.
  source_id       uuid,

  payload         jsonb NOT NULL,

  status          text NOT NULL DEFAULT 'PENDING',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- Which worker holds it, and until when. A process that dies mid-write
  -- leaves a lease that expires rather than a row nobody will ever pick up.
  lease_owner     text,
  lease_expires_at timestamptz,

  -- Where it landed, for tracing: the tab and the row number.
  written_tab     text,
  written_row     integer,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  written_at      timestamptz,

  CONSTRAINT wh_sheet_events_status_check
    CHECK (status IN ('PENDING', 'SENDING', 'WRITTEN', 'FAILED', 'DEAD'))
);

-- The claim order: due first, oldest first.
CREATE INDEX wh_sheet_events_due_idx
  ON wh_sheet_events (next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX wh_sheet_events_source_idx
  ON wh_sheet_events (source_id) WHERE source_id IS NOT NULL;

/* ==================================================== read cache === */
-- What was last read out of the sheet.
--
-- The ledger is tens of thousands of rows and the catalogue is long enough
-- that re-reading either on every page load would make the module unusable.
-- This is a cache and is treated as one: it can be thrown away and rebuilt,
-- and nothing is ever decided from it that is not also true in the sheet.

CREATE TABLE wh_cache (
  key         text PRIMARY KEY,
  payload     jsonb NOT NULL,
  -- The sheet's own last-modified time when this was read, so a refresh can
  -- tell "nothing changed" from "we have not looked".
  source_rev  text,
  rows        integer NOT NULL DEFAULT 0,
  read_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX wh_cache_expiry_idx ON wh_cache (expires_at);

/* ================================================ approval queue === */
-- A member's edit or delete waits for a manager.
--
-- Mirrors the Apps Script's App Approvals tab, with the two faults it had
-- fixed in the schema rather than in the code that reads it: a request
-- carries who asked, and the decision carries who decided, so a self-approval
-- is a condition that can be checked rather than a convention.

CREATE TABLE wh_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  kind          text NOT NULL,
  requested_by  uuid NOT NULL REFERENCES core_users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),

  -- The row in the sheet this is about, and what it should become.
  target_ref    text NOT NULL,
  payload       jsonb NOT NULL,
  reason        text,

  status        text NOT NULL DEFAULT 'PENDING',
  decided_by    uuid REFERENCES core_users(id),
  decided_at    timestamptz,
  decision_note text,

  CONSTRAINT wh_approvals_kind_check CHECK (kind IN ('EDIT', 'DELETE')),
  CONSTRAINT wh_approvals_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'FAILED')),

  -- A decided request has a decider and a time; a pending one has neither.
  CONSTRAINT wh_approvals_decision_complete CHECK (
    (status IN ('PENDING', 'PROCESSING')) = (decided_at IS NULL)
  ),

  -- The rule the Apps Script enforces in code, here as a constraint: nobody
  -- decides their own request. A convention can be forgotten by the next
  -- person to touch the code; this cannot.
  CONSTRAINT wh_approvals_no_self_decision CHECK (
    decided_by IS NULL OR decided_by <> requested_by
  )
);

CREATE INDEX wh_approvals_pending_idx
  ON wh_approvals (requested_at) WHERE status = 'PENDING';