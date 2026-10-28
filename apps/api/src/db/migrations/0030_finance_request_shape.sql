-- 0030_finance_request_shape.sql
-- Correcting the request shape against the form people actually fill in.
--
-- 0029 assumed every request carries an amount. Reading the legacy addEntry
-- shows it does not: a request routed to Purchases carries no amount, no type
-- and no transfer details, because none of those are known yet. The requester
-- says what is needed; Purchases decides what it costs, what kind of spending
-- it is and where the money goes, when it approves.
--
-- Amended here rather than by editing 0029, which has already been applied:
-- the migration runner checksums applied files and refuses to start if one
-- changes, which is the behaviour that keeps an environment honest about what
-- has actually run.

/* ------------------------------------------------- the amount is optional */
-- Only for a request that goes to Purchases first. A request going straight to
-- Finance must still carry a positive amount, which is what the old constraint
-- said for everything.

ALTER TABLE fin_requests DROP CONSTRAINT IF EXISTS fin_requests_amount_positive;

ALTER TABLE fin_requests ALTER COLUMN requested_amount DROP NOT NULL;
ALTER TABLE fin_requests ALTER COLUMN requested_amount SET DEFAULT NULL;

ALTER TABLE fin_requests ADD CONSTRAINT fin_requests_amount_matches_route CHECK (
  CASE
    -- Purchases will price it. Null until then; zero is allowed too, because
    -- the legacy form lets an estimate of nothing through and migrated rows
    -- will carry it.
    WHEN route = 'purchases' THEN requested_amount IS NULL OR requested_amount >= 0
    -- Going straight to Finance: somebody is asking for a specific sum.
    ELSE requested_amount IS NOT NULL AND requested_amount > 0
  END
);

/* ------------------------------ the type is Purchases' to choose as well -- */
-- A `choice` department that sends to Purchases does not pick a type either:
-- the legacy app writes "Not set" and lets Purchases replace it. Null says the
-- same thing without a magic string, and the constraint stops a type being
-- invented for a request nobody has classified yet.

ALTER TABLE fin_requests ADD CONSTRAINT fin_requests_type_matches_route CHECK (
  route <> 'finance' OR type IS NOT NULL
);

/* ------------------------------------------- transfer details, structured */
-- The legacy app stores the whole thing as one string, assembled and then
-- re-parsed by position: "<bank> - <number> | Beneficiary: <name>". Parsing a
-- display string to find out who was paid is how a beneficiary goes missing
-- when somebody types a hyphen in a bank name.
--
-- The parts are columns. The assembled string is kept as well, because it is
-- what the migration will carry over from the sheet and what Zoho receives.

ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS account_number text;
ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS beneficiary_name text;

-- A bank transfer must say who is being paid. The legacy app enforces this in
-- the form only, so a row written any other way escapes it.
ALTER TABLE fin_requests ADD CONSTRAINT fin_requests_bank_has_beneficiary CHECK (
  payment_method NOT IN ('Bank Account Number', 'IBAN')
  OR beneficiary_name IS NOT NULL
);

/* ------------------------------------------------------------ the banks -- */
-- The list the form offers, as data. In the legacy app it is a constant in the
-- script, so adding a bank means a redeployment.

CREATE TABLE fin_banks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL UNIQUE,
  name_ar   text,
  position  integer NOT NULL DEFAULT 0,
  active    boolean NOT NULL DEFAULT true
);

INSERT INTO fin_banks (name, position) VALUES
  ('National Bank of Egypt (NBE)', 1),
  ('Banque Misr', 2),
  ('Commercial International Bank (CIB)', 3),
  ('Banque du Caire', 4),
  ('QNB Egypt', 5),
  ('Housing and Development Bank (HDB)', 6),
  ('Faisal Islamic Bank of Egypt', 7),
  ('Arab African International Bank (AAIB)', 8),
  ('Bank of Alexandria', 9),
  ('Egyptian Gulf Bank (EG Bank)', 10),
  ('Suez Canal Bank (SCB)', 11),
  ('Abu Dhabi Islamic Bank Egypt (ADIB)', 12),
  ('Emirates NBD Egypt', 13),
  ('First Abu Dhabi Bank Egypt (FAB)', 14),
  ('Arab Bank', 15),
  ('Credit Agricole Egypt', 16),
  ('HSBC Egypt', 17),
  ('Mashreq Bank Egypt', 18),
  ('Kuwait Finance House Egypt (KFH)', 19),
  ('Al Ahli Bank of Kuwait Egypt (ABK)', 20),
  ('National Bank of Kuwait Egypt (NBK)', 21),
  ('Union National Bank Egypt (UNB)', 22),
  ('Export Development Bank of Egypt (EBE)', 23),
  ('Industrial Development and Workers Bank (IDWBE)', 24),
  ('Arab Investment Bank (aiBank)', 25),
  ('Egyptian Arab Land Bank', 26),
  ('Agricultural Bank of Egypt', 27),
  ('Societe Arabe Internationale de Banque (SAIB)', 28),
  ('Arab International Bank (AIB)', 29),
  ('Al Baraka Bank Egypt', 30),
  ('Nasser Social Bank', 31),
  ('Misr Iran Development Bank', 32),
  ('Arab Banking Corporation Egypt (ABC)', 33),
  ('Attijariwafa Bank Egypt', 34),
  ('Blom Bank Egypt', 35),
  ('Citibank Egypt', 36),
  ('Bank NXT', 37),
  ('Other bank', 38)
ON CONFLICT (name) DO NOTHING;