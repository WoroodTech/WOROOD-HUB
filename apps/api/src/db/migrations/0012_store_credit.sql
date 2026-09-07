-- 0012_store_credit.sql
-- Store credit issued and spent.
--
-- Confirmed against the live schema before writing: `StoreCreditAccount` has a
-- `transactions` connection, and each transaction carries an amount, the
-- balance after it, a timestamp, a system event and an origin. So a usage
-- report is possible -- the open question was whether Shopify exposed a ledger
-- or only a current balance, and it is a ledger.
--
-- Two things shape the table.
--
-- **Sign is meaning.** A credit is positive, a debit negative, and the report
-- turns on the difference: how much was issued against how much was actually
-- spent. Storing an absolute value with a separate direction flag would let the
-- two drift; the sign is kept as Shopify sends it.
--
-- **`balance_after` is stored even though it is derivable.** It is Shopify's
-- own running total at that moment, and having it means a discrepancy between
-- our sum and their balance is visible rather than assumed away. If they ever
-- disagree, the ledger is wrong and we want to know.
--
-- Not protected customer data in itself -- an amount and a date -- but it joins
-- to a customer, so reads go through the same permission as any other
-- customer-identifying view.

CREATE TABLE IF NOT EXISTS sd_store_credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES sd_shops(id),
  shopify_gid text NOT NULL UNIQUE,

  customer_id uuid REFERENCES sd_customers(id) ON DELETE CASCADE,
  account_gid text,

  -- Positive credits the account, negative debits it. Shopify's sign, kept.
  amount numeric(18,4) NOT NULL,
  balance_after numeric(18,4),
  currency_code text,

  -- Shopify's own classification. Stored as text rather than an enum: the
  -- values are Shopify's to change, and a CHECK constraint here would turn a
  -- new event type into a failed sync rather than an unfamiliar label.
  event text,
  origin_type text,

  shopify_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sd_store_credit_recent_idx
  ON sd_store_credit_transactions (shop_id, shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS sd_store_credit_customer_idx
  ON sd_store_credit_transactions (customer_id, shopify_created_at DESC);

-- The current balance per customer, kept on the customer row so the "credit
-- outstanding" figure does not have to sum the whole ledger on every read.
ALTER TABLE sd_customers
  ADD COLUMN IF NOT EXISTS store_credit_balance numeric(18,4) NOT NULL DEFAULT 0;

INSERT INTO sd_sync_state (shop_id, resource, status)
SELECT id, 'store_credit', 'PENDING' FROM sd_shops
ON CONFLICT (shop_id, resource) DO NOTHING;