-- 0049_finance_po_issued.sql
-- "Mark as received" for a purchase order.
--
-- A purchase order is created as a draft. Purchasing then confirms the goods
-- are on their way by issuing it — in Zoho this moves the order from Draft to
-- Open, which is what "Mark as received" does from the portal.
--
-- Tracked here so the button knows whether it has already been pressed, and
-- so the request page can show the order as issued without asking Zoho every
-- time it is opened.

ALTER TABLE fin_purchase_orders
  ADD COLUMN IF NOT EXISTS issued_at    timestamptz,
  ADD COLUMN IF NOT EXISTS issued_by_id uuid REFERENCES core_users(id);

COMMENT ON COLUMN fin_purchase_orders.issued_at IS
  'When Purchasing marked the order as received, moving it from Draft to Open in Zoho.';