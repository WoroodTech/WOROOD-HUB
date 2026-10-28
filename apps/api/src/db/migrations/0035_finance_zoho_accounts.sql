-- 0035_finance_zoho_accounts.sql
-- Which Zoho account a payment moves money between.
--
-- 0034 assumed four fixed accounts in configuration. Reading the legacy
-- integration shows that is not how it works: the expense account is chosen
-- per request from the whole expense chart, the custody target is one of about
-- fifteen accounts under "Petty Cash", and only the pay-from side is a short
-- list of four. A single ZOHO_EXPENSE_ACCOUNT_ID would have posted every
-- department's spending to one line of the accounts.
--
-- So the accounts are data: a cache of what Zoho has, refreshed from Zoho, and
-- a choice recorded against each payment.

/* ----------------------------------------------------- the account cache */
-- Zoho is the authority; this is a copy so a form can be filled in without a
-- round trip, and so a payment keeps the name an account had when it was
-- chosen even if it is renamed later.

CREATE TABLE fin_zoho_accounts (
  account_id    text PRIMARY KEY,
  account_name  text NOT NULL,

  -- bank | cash | credit_card | expense | other, as Zoho reports it.
  account_type  text,

  -- "Petty Cash" children are the custody targets; the expense chart is
  -- several levels deep. Kept so the UI can group them the way Zoho does.
  parent_id     text,
  parent_name   text,

  currency_code text,
  active        boolean NOT NULL DEFAULT true,

  -- Which of our purposes this account may serve. Several can be true: an
  -- account under Petty Cash is both a cash account and a custody target.
  is_pay_from   boolean NOT NULL DEFAULT false,
  is_custody    boolean NOT NULL DEFAULT false,
  is_expense    boolean NOT NULL DEFAULT false,

  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fin_zoho_accounts_purpose_idx
  ON fin_zoho_accounts (is_pay_from, is_custody, is_expense)
  WHERE active;

/* ------------------------------------------- what each payment is posted to */
-- Recorded on the payment rather than the request, because a request paid in
-- two instalments may legitimately go out of two different accounts.
--
-- Nullable: a payment recorded while Zoho is switched off still needs to be
-- recordable, and the queue reports what it could not post rather than
-- refusing the payment.

ALTER TABLE fin_payments
  ADD COLUMN IF NOT EXISTS zoho_paid_through_account_id text,
  ADD COLUMN IF NOT EXISTS zoho_expense_account_id text,
  ADD COLUMN IF NOT EXISTS zoho_to_account_id text;

COMMENT ON COLUMN fin_payments.zoho_paid_through_account_id IS
  'Where the money left from. Required for every kind of posting.';
COMMENT ON COLUMN fin_payments.zoho_expense_account_id IS
  'Which expense line it lands on. Required for an expense; not used for a '
  'custody transfer or a vendor payment.';
COMMENT ON COLUMN fin_payments.zoho_to_account_id IS
  'The custody account money was moved into. Petty Cash only.';

/* ------------------------------------------------------------ branches -- */
-- Existing expenses in the organisation carry a branch ("WoRood Local",
-- "WoRood Global") and the legacy payload does not send one, so Zoho assigns
-- its default. Recorded here so a decision to start sending one does not need
-- a migration, and so the column is visibly empty until somebody decides.

ALTER TABLE fin_payments ADD COLUMN IF NOT EXISTS zoho_branch_id text;