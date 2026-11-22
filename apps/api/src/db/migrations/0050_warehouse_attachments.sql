/*
 * Files attached to warehouse work.
 *
 * A return and a return issue both want a photograph — what arrived, what
 * state it was in. The Apps Script asked for a Drive link pasted into a text
 * box, which meant the picture lived in somebody's own Drive, was readable by
 * whoever had the link, and broke when that person left or tidied up.
 *
 * Modelled on `fin_request_files`, deliberately: same three steps (ask for a
 * URL, put the bytes straight into S3, confirm what arrived), same states,
 * same rule that a READY row cannot exist without its object. One shape to
 * learn rather than two.
 *
 * The one difference is what a file belongs to. Finance rows point at a
 * request in this database; warehouse work lives in the Google Sheet, so the
 * reference is the sheet's own identifier — a return issue's `Issue ID`, a
 * movement's patch number — held as text. There is nothing here to key
 * against, so `subject_kind` says which kind of thing `subject_id` names.
 */

CREATE TABLE wh_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RETURN_ISSUE — a row in the sheet's Return Issues tab, by its Issue ID.
  -- MOVEMENT     — a ledger movement, by its patch number.
  subject_kind  text NOT NULL,
  subject_id    text NOT NULL,

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

  CONSTRAINT wh_attachments_subject_kind_check
    CHECK (subject_kind IN ('RETURN_ISSUE', 'MOVEMENT')),
  CONSTRAINT wh_attachments_status_check
    CHECK (status IN ('PENDING', 'READY', 'DELETED')),
  -- A READY row without its object is a broken link on the page; the
  -- constraint makes that state impossible rather than merely unlikely.
  CONSTRAINT wh_attachments_ready_is_complete
    CHECK (status <> 'READY' OR (file_key IS NOT NULL AND content_type IS NOT NULL))
);

CREATE INDEX wh_attachments_live_idx
  ON wh_attachments (subject_kind, subject_id, created_at)
  WHERE status = 'READY' AND deleted_at IS NULL;