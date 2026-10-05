-- 0020_ticket_attachments.sql
-- Images and PDFs on tickets and on comments, stored in S3.
--
-- The bytes never pass through the API. The browser uploads to a short-lived
-- presigned URL under `incoming/`, tells the API it has finished, and the API
-- reads the object, checks what it actually is, compresses it, writes the result
-- under `files/` and deletes the original. This table is the record of that,
-- and the only thing that makes an object in the bucket visible to anybody.
--
-- A row is born PENDING, when the upload URL is issued. It becomes READY once
-- the API has inspected and stored the file, and only READY rows are ever shown.
-- A PENDING row nobody confirms is an abandoned upload: the bucket's lifecycle
-- rule deletes `incoming/` after a day, and the row is harmless meanwhile
-- because nothing reads it.

CREATE TABLE tk_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES tk_items(id) ON DELETE CASCADE,
  -- Null for an attachment on the ticket itself (added when it was raised);
  -- set for one added alongside a comment during the lifecycle.
  comment_id      uuid REFERENCES tk_comments(id) ON DELETE CASCADE,
  uploaded_by     uuid NOT NULL REFERENCES core_users(id),

  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','READY','DELETED')),
  kind            text CHECK (kind IN ('IMAGE','PDF')),

  -- What the person called it. Shown in the interface and offered as the
  -- download name, and never used to build a key: keys are uuids, so no file
  -- name can steer where anything is written.
  original_name   text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  -- What the browser claimed. Recorded, not trusted: the type that matters is
  -- read from the file's own first bytes on confirmation.
  declared_type   text NOT NULL,

  incoming_key    text NOT NULL UNIQUE,
  file_key        text UNIQUE,
  thumb_key       text UNIQUE,
  content_type    text,

  -- Both sizes, so "how much did compression save" is a query rather than a
  -- guess, and so storage can be reasoned about from the database.
  original_bytes  integer,
  bytes           integer,
  width           integer,
  height          integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES core_users(id),

  CONSTRAINT tk_attachments_ready_is_complete CHECK (
    status <> 'READY' OR (file_key IS NOT NULL AND kind IS NOT NULL AND bytes IS NOT NULL)
  )
);

-- Detail reads every live attachment of one ticket at once.
CREATE INDEX tk_attachments_item_idx
  ON tk_attachments (item_id, created_at)
  WHERE status = 'READY';

-- Limits are counted per ticket and per comment, live files only.
CREATE INDEX tk_attachments_comment_idx
  ON tk_attachments (comment_id)
  WHERE comment_id IS NOT NULL AND status <> 'DELETED';