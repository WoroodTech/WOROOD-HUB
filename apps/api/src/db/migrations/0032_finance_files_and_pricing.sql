-- 0032_finance_files_and_pricing.sql
-- Attachments on a request, and what Purchases decides when it approves one.
--
-- Two things that arrive together because the Purchases step needs both: a
-- quotation is the usual reason to attach something, and pricing is what the
-- step is for.

/* --------------------------------------------------------------- files -- */
-- The same two-step upload the announcements use: a row first, the bytes
-- straight from the browser into S3, and the row becomes READY only once the
-- API has looked at what actually arrived. A row that is never confirmed is an
-- abandoned upload and is simply never shown.
--
-- The legacy app keeps files in a Drive folder shared by link, which is how a
-- receipt carrying bank details became readable by four departments at once.
-- Here every download is a signed URL issued after a server-side check of who
-- is asking.

CREATE TABLE fin_request_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL REFERENCES fin_requests(id) ON DELETE CASCADE,

  -- ATTACHMENT — a quotation, an invoice, a photograph of what is needed.
  -- RECEIPT    — proof that money went out. Phase 3 writes these; the column
  --              exists now so the two never end up in separate tables with
  --              separate rules about who may read them.
  kind          text NOT NULL DEFAULT 'ATTACHMENT',

  status        text NOT NULL DEFAULT 'PENDING',
  incoming_key  text,
  file_key      text,
  thumb_key     text,
  content_type  text,
  original_name text,
  bytes         bigint,
  width         integer,
  height        integer,

  uploaded_by   uuid NOT NULL REFERENCES core_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ready_at      timestamptz,
  deleted_at    timestamptz,

  CONSTRAINT fin_request_files_kind_check
    CHECK (kind IN ('ATTACHMENT', 'RECEIPT')),
  CONSTRAINT fin_request_files_status_check
    CHECK (status IN ('PENDING', 'READY', 'DELETED')),
  -- A READY row without its object is a broken link on the page; the
  -- constraint makes that state impossible rather than merely unlikely.
  CONSTRAINT fin_request_files_ready_is_complete
    CHECK (status <> 'READY' OR (file_key IS NOT NULL AND content_type IS NOT NULL))
);

CREATE INDEX fin_request_files_live_idx
  ON fin_request_files (request_id, kind, created_at)
  WHERE status = 'READY' AND deleted_at IS NULL;

/* ------------------------------------------------- what Purchases adds -- */
-- A request routed to Purchases arrives with no amount, no type and no
-- transfer details: the requester said what was needed, not what it costs.
-- Purchases supplies all of that when it approves, and only then can the
-- request mean anything to Finance.
--
-- Recorded as its own columns rather than written over the request's, so
-- "what was asked for" and "what Purchases decided" stay distinguishable --
-- the legacy app overwrites, and then nobody can tell whether a figure came
-- from the department or from Purchases.

ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS priced_by_id uuid REFERENCES core_users(id);
ALTER TABLE fin_requests ADD COLUMN IF NOT EXISTS priced_at timestamptz;

-- Purchases must leave a request complete enough for Finance to pay it. A
-- priced request carries a type, an amount and a way to send the money.
ALTER TABLE fin_requests ADD CONSTRAINT fin_requests_priced_is_complete CHECK (
  priced_at IS NULL
  OR (type IS NOT NULL AND requested_amount IS NOT NULL AND requested_amount > 0
      AND payment_method IS NOT NULL)
);

-- Once Purchases has priced a request it leaves the asking department's
-- cash-flow line and joins Purchases': this is what the legacy app expressed by
-- physically moving the row into the Purchases Log.
COMMENT ON COLUMN fin_requests.charged_to_department_id IS
  'Which cash-flow bucket this is charged to. The asking department until '
  'Purchases prices it, Purchases afterwards.';