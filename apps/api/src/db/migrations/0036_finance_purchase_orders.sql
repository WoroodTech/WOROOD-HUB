-- 0036_finance_purchase_orders.sql
-- Draft purchase orders, for vendor payments.
--
-- When Purchases pays a supplier rather than handing out petty cash, the
-- legacy app creates a Draft purchase order in Zoho Books first and then
-- records the payment as an advance against it. The draft is what the supplier
-- is shown and what the accounts later match the payment to.
--
-- Created as a draft on purpose: approving it is a decision for whoever runs
-- the accounts, in Zoho, where the rest of the approval chain for purchase
-- orders already lives. Nothing here approves one.

CREATE TABLE fin_purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,

  -- The supplier, as Zoho knows them. The name is kept beside the id so a
  -- draft still reads correctly if the contact is later renamed or merged.
  vendor_zoho_id text,
  vendor_name   text NOT NULL,

  /*
   * The reference the supplier sees.
   *
   * Computed from the vendor's own latest bill reference plus one -- the
   * legacy app reads Zoho's bills, finds the highest number sharing a prefix,
   * and increments it, preserving any zero padding. Whatever the page sends is
   * ignored when Zoho can answer, because the supplier's own numbering is the
   * thing that must stay continuous.
   */
  reference     text,

  /* Up to forty, as the legacy form allows. Stored as sent rather than
     normalised into rows: they are a snapshot of what was ordered, not
     something anything else joins against. */
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  total         numeric(14,2),

  status        text NOT NULL DEFAULT 'PENDING',

  -- What Zoho gave back.
  zoho_po_id    text,
  zoho_po_number text,
  error         text,

  created_by_id uuid NOT NULL REFERENCES core_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  posted_at     timestamptz,

  CONSTRAINT fin_purchase_orders_status_check
    CHECK (status IN ('PENDING', 'DRAFTED', 'FAILED')),
  -- A drafted order without Zoho's id cannot be matched to a payment later,
  -- which is the whole reason for creating it.
  CONSTRAINT fin_purchase_orders_drafted_is_complete
    CHECK (status <> 'DRAFTED' OR (zoho_po_id IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT fin_purchase_orders_lines_present
    CHECK (jsonb_array_length(lines) BETWEEN 1 AND 40)
);

-- One order per request: a second would leave the payment ambiguous about
-- which it is an advance against.
CREATE UNIQUE INDEX fin_purchase_orders_one_per_request
  ON fin_purchase_orders (request_id);

-- The payment that goes out against this order carries its reference, so the
-- two can be matched in Zoho afterwards.
ALTER TABLE fin_requests
  ADD COLUMN IF NOT EXISTS purchase_order_reference text;

COMMENT ON COLUMN fin_requests.purchase_order_reference IS
  'The draft purchase order this request was ordered under, if any. A vendor '
  'payment with one posts as an advance against it; without one the legacy app '
  'posts nothing at all, and neither does this.';

/* ------------------------------------------------------- vendor cache -- */
-- Suppliers, cached from Zoho the way the accounts are. The legacy app fetches
-- the whole contact list on every page load, which is fifteen pages of API
-- calls to fill one dropdown.

CREATE TABLE fin_zoho_vendors (
  vendor_id     text PRIMARY KEY,
  vendor_name   text NOT NULL,
  company_name  text,
  email         text,
  active        boolean NOT NULL DEFAULT true,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fin_zoho_vendors_name_idx ON fin_zoho_vendors (vendor_name) WHERE active;