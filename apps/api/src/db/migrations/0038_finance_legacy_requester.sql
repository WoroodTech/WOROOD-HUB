-- 0038_finance_legacy_requester.sql
-- Requests from people who no longer work here.
--
-- 0029 requires every request to point at a portal account, which is right for
-- anything raised here: somebody raised it, and they are logged in.
--
-- It is wrong for history. A request made in 2024 by somebody who left in 2025
-- is a fact that happened, and the migration was refusing to carry it across
-- because there is nobody to point at. The alternative -- creating dormant
-- accounts for everybody who ever worked here -- would fill the staff list
-- with people who cannot log in, so that a foreign key is satisfied.
--
-- So a migrated request may have no account behind it, and keeps the name the
-- spreadsheet recorded instead. The constraint still holds for everything
-- raised in the portal, which is where it matters.

ALTER TABLE fin_requests ALTER COLUMN requester_id DROP NOT NULL;

-- Who the spreadsheet said asked for it. Only ever set on migrated rows.
ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS legacy_requested_by text;

-- The rule, stated where it cannot be forgotten: a request raised here must
-- have an account; a migrated one must at least have a name.
ALTER TABLE fin_requests ADD CONSTRAINT fin_requests_has_a_requester CHECK (
  requester_id IS NOT NULL
  OR (legacy_id IS NOT NULL AND legacy_requested_by IS NOT NULL)
);

COMMENT ON COLUMN fin_requests.legacy_requested_by IS
  'The name the spreadsheet recorded, for a migrated request whose author has '
  'no portal account — usually because they have left. Null for anything '
  'raised in the portal, which always has a real requester_id.';

-- Payments carried across have the same problem: the person who recorded them
-- may be gone too.
ALTER TABLE fin_payments ALTER COLUMN recorded_by_id DROP NOT NULL;
ALTER TABLE fin_payments ADD COLUMN IF NOT EXISTS legacy_recorded_by text;

ALTER TABLE fin_payments ADD CONSTRAINT fin_payments_has_a_recorder CHECK (
  recorded_by_id IS NOT NULL OR legacy_id IS NOT NULL
);