-- 0034_finance_zoho.sql
-- Posting to Zoho Books, as a queue rather than a hope.
--
-- The legacy app posts inline, at the moment a payment is recorded: if Zoho is
-- slow the person waits, and if Zoho refuses the payment is already in the
-- sheet and the failure is a line in a hidden log tab that nobody reads. The
-- handover lists this as a known limitation, and it is the one that matters
-- most -- a payment that never reached the accounts is invisible until
-- somebody reconciles by hand.
--
-- Here the intention to post is a durable row with its own lifecycle, claimed
-- and retried by a worker. The same shape as sd_webhook_events, which has been
-- draining Shopify webhooks in production for weeks: states, attempts, a lease
-- so two workers cannot take the same row, and a dead-letter state that is
-- visible rather than silent.

CREATE TABLE fin_zoho_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- EXPENSE          — an ordinary department's spending
  -- VENDOR_PAYMENT   — a supplier paid against a purchase order
  -- CUSTODY_TRANSFER — petty cash moved to whoever holds it
  kind          text NOT NULL,

  request_id    uuid REFERENCES fin_requests(id) ON DELETE SET NULL,
  payment_id    uuid REFERENCES fin_payments(id) ON DELETE SET NULL,

  -- The body to post, built when the event is queued rather than when it is
  -- sent: what should go to Zoho is what was true at the moment the payment
  -- was recorded, not whatever the request has become since.
  payload       jsonb NOT NULL,

  /*
   * The defence against posting the same thing twice.
   *
   * Derived from our own payment id, so a retry after a timeout sends an
   * identical reference. Before creating anything, the worker asks Zoho
   * whether a record with this reference already exists and adopts it if so --
   * which is what makes the dangerous case survivable: Zoho succeeded and we
   * never heard.
   */
  idempotency_key text NOT NULL UNIQUE,

  status        text NOT NULL DEFAULT 'PENDING',
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,

  -- Claimed by one worker for a while. If that worker dies the lease expires
  -- and the row becomes claimable again, rather than being stuck forever.
  lease_owner   text,
  lease_expires_at timestamptz,

  -- What came back.
  zoho_record_id text,
  zoho_reference text,
  error         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  posted_at     timestamptz,

  CONSTRAINT fin_zoho_events_kind_check
    CHECK (kind IN ('EXPENSE', 'VENDOR_PAYMENT', 'CUSTODY_TRANSFER')),
  CONSTRAINT fin_zoho_events_status_check CHECK (status IN (
    'PENDING',     -- waiting to be sent
    'PROCESSING',  -- a worker holds a lease on it
    'POSTED',      -- Zoho has it, and we have its id
    'FAILED',      -- refused; will be retried
    'DEAD',        -- out of attempts, waiting for a person
    'SKIPPED',     -- nothing to post: a vendor payment with no purchase order
    'SUPERSEDED'   -- migrated from the sheet; already in Zoho, never re-post
  )),
  -- A posted event without Zoho's id cannot be reconciled afterwards, which
  -- defeats the point of recording it.
  CONSTRAINT fin_zoho_events_posted_is_complete
    CHECK (status <> 'POSTED' OR (zoho_record_id IS NOT NULL AND posted_at IS NOT NULL))
);

-- What a worker claims: due, unclaimed or lease expired. Partial, because
-- posted events are the overwhelming majority after a month and none of them
-- is ever claimed again.
CREATE INDEX fin_zoho_events_claimable_idx
  ON fin_zoho_events (next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

-- The operations screen: what is stuck, and what failed.
CREATE INDEX fin_zoho_events_attention_idx
  ON fin_zoho_events (status, created_at)
  WHERE status IN ('DEAD', 'PROCESSING');

-- Reconciliation: find our row from Zoho's id.
CREATE INDEX fin_zoho_events_record_idx
  ON fin_zoho_events (zoho_record_id) WHERE zoho_record_id IS NOT NULL;