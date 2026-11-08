-- 0043_order_payment_reference.sql
-- The gateway's own reference for an order's payment, for reconciliation.
--
-- Finance matches the gateway's settlement statement against orders, and the
-- only thing that ties a line on that statement to an order here is the
-- reference the gateway itself issued.
--
-- **Where it comes from.** `/orders/{id}/transactions.json` returns it, but
-- that is one request per order -- fifty orders on a page would be fifty
-- calls to Shopify every time somebody opened it. The same fields exist on
-- the `transactions` connection of the GraphQL `Order`, which the sync
-- already fetches, so they arrive with the order and cost nothing extra.
--
-- **Three columns, not one.** Gateways disagree about where they put the
-- identifier: some fill `paymentId`, some only `authorizationCode`, and some
-- put the useful number inside the receipt. Keeping one and discarding the
-- rest would make an empty cell mean "this gateway uses a different field"
-- while reading as "this order has no payment" -- and somebody reconciling
-- would mark the order as missing from the statement.

ALTER TABLE sd_orders
  ADD COLUMN IF NOT EXISTS payment_id text,
  ADD COLUMN IF NOT EXISTS payment_authorization text,
  ADD COLUMN IF NOT EXISTS payment_gateway text,
  -- The gateway's own receipt, as it sent it. Shapes differ per gateway, so
  -- it is kept whole rather than parsed into columns that would be wrong for
  -- the next gateway the shop adds.
  ADD COLUMN IF NOT EXISTS payment_receipt jsonb;

COMMENT ON COLUMN sd_orders.payment_id IS
  'The gateway''s reference for the successful sale or capture on this order. '
  'Null where the gateway does not provide one, which is not the same as the '
  'order being unpaid.';

-- Reconciliation starts from a reference on a statement and looks for the
-- order, so this is the direction the index needs to serve.
CREATE INDEX IF NOT EXISTS sd_orders_payment_id_idx
  ON sd_orders (payment_id)
  WHERE payment_id IS NOT NULL;

/* ----------------------------------------------------------- who sees -- */
-- A permission of its own, held by Finance.
--
-- Not folded into `sales.order.view`: everybody who browses orders would get
-- it, and a gateway reference is a key into the payment provider's records
-- rather than part of an order anybody needs to read.
--
-- Granted here rather than through `seed.ts`, which cannot be run on a live
-- database -- it deletes every role's permissions before re-inserting them,
-- reverting every grant made by hand since launch.

INSERT INTO core_permissions (key, module_key, description)
VALUES ('sales.order.payment.view', 'sales-dashboard',
        'See the payment gateway reference on an order')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, description = EXCLUDED.description;

INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r
  CROSS JOIN core_permissions p
 WHERE r.key IN ('finance', 'admin')
   AND p.key = 'sales.order.payment.view'
ON CONFLICT DO NOTHING;