-- 0031_finance_edits.sql
-- Changing a request after it has been approved.
--
-- While a request is Open, the person who raised it edits it in place: nobody
-- has agreed to anything yet. Once it is approved, the amount has been agreed
-- by everybody who decided it, so changing it is a new decision for all of
-- them. That is what this table carries.
--
-- The chain is the same one the request itself went through -- department
-- manager, then Finance -- and nothing changes on the request until both have
-- said yes. The legacy app has an Edit Requests tab doing roughly this, but
-- applies the change from two different code paths with two different rules,
-- which is how an amount could be edited below what had already been paid from
-- one of them and not the other. Here there is one path.

CREATE TABLE fin_request_edits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,
  requested_by_id uuid NOT NULL REFERENCES core_users(id),

  -- What is being asked for. Null means "leave this as it is", so an edit that
  -- only changes the amount does not have to restate the description.
  new_amount      numeric(14,2),
  new_description text,
  new_more_details text,
  new_due_date    date,
  new_payment_method text,
  new_payment_details text,
  new_bank_name   text,
  new_account_number text,
  new_beneficiary_name text,

  -- Why. Required: an approver being asked to agree to a different number
  -- needs to know what changed about the world, and this is the complaint the
  -- legacy app generates most.
  reason        text NOT NULL,

  -- What the request said when the edit was raised, so an approval cannot be
  -- read as covering a figure that has since moved.
  amount_before numeric(14,2),

  status        text NOT NULL DEFAULT 'MANAGER_PENDING',

  manager_decided_by_id uuid REFERENCES core_users(id),
  manager_decided_at    timestamptz,
  finance_decided_by_id uuid REFERENCES core_users(id),
  finance_decided_at    timestamptz,
  decision_reason text,

  -- When the change actually reached the request.
  applied_at    timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fin_request_edits_status_check CHECK (status IN (
    'MANAGER_PENDING',   -- with the requester's department manager
    'FINANCE_PENDING',   -- with Finance
    'APPLIED',           -- agreed by both, and the request has been changed
    'REJECTED',
    'WITHDRAWN'          -- taken back by the person who raised it
  )),
  -- An edit that asks for nothing is a note, not an edit.
  CONSTRAINT fin_request_edits_asks_for_something CHECK (
    new_amount IS NOT NULL OR new_description IS NOT NULL
    OR new_more_details IS NOT NULL OR new_due_date IS NOT NULL
    OR new_payment_method IS NOT NULL OR new_account_number IS NOT NULL
  ),
  CONSTRAINT fin_request_edits_reason_present CHECK (length(btrim(reason)) > 0),
  CONSTRAINT fin_request_edits_applied_is_complete CHECK (
    status <> 'APPLIED' OR (applied_at IS NOT NULL AND finance_decided_at IS NOT NULL)
  ),
  -- A new amount of zero or less is not a request for money.
  CONSTRAINT fin_request_edits_amount_positive CHECK (
    new_amount IS NULL OR new_amount > 0
  )
);

CREATE TRIGGER fin_request_edits_touch BEFORE UPDATE ON fin_request_edits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The approvals queue asks this: what edits are waiting on me.
CREATE INDEX fin_request_edits_pending_idx
  ON fin_request_edits (status, created_at)
  WHERE status IN ('MANAGER_PENDING', 'FINANCE_PENDING');

CREATE INDEX fin_request_edits_request_idx
  ON fin_request_edits (request_id, created_at);

-- One open edit per request at a time.
--
-- Two people asking for different amounts on the same request, both approved,
-- would leave the request holding whichever was applied last with no record of
-- the contradiction. A partial unique index says it in the schema rather than
-- in a check somebody can forget: the second request to edit is refused while
-- the first is still being decided.
CREATE UNIQUE INDEX fin_request_edits_one_open_per_request
  ON fin_request_edits (request_id)
  WHERE status IN ('MANAGER_PENDING', 'FINANCE_PENDING');