-- 0028_announcements.sql
-- Company news: what HR puts on the home page.
--
-- This has been living in a chat room. That works for the hour after it is
-- posted and then it is gone: somebody on leave that week never sees it, and
-- the quarter's stars scroll past a conversation about printer paper. A board
-- everyone lands on is a different thing from a message everyone was sent.
--
-- Three tables rather than one, because the three have different lifetimes and
-- different audiences: the announcement is written once and read by everybody,
-- an image belongs to one announcement and goes when it goes, and a comment
-- belongs to the person who wrote it.

CREATE TABLE hr_announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both languages optional on each side: a notice may be written in Arabic
  -- only, in English only, or in both. The reader is given whichever exists,
  -- preferring their own, so a one-language notice is still readable rather
  -- than an empty card.
  title       text,
  title_ar    text,
  body        text,
  body_ar     text,

  -- DRAFT is written but not shown; PUBLISHED is live between its dates;
  -- ARCHIVED was taken down by hand before its time was up.
  status      text NOT NULL DEFAULT 'DRAFT',

  -- When it starts appearing, and when it stops. Both are decided by whoever
  -- writes it rather than by a fixed rule: the quarter's stars deserve longer
  -- than a reminder about Thursday's maintenance, and nobody can guess that
  -- from here. Null expiry means it stays until taken down, which is the right
  -- answer for the rare notice that should not quietly vanish.
  publish_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,

  -- Pinned notices sort first regardless of date, for the one thing that must
  -- be seen before anything else.
  pinned      boolean NOT NULL DEFAULT false,

  -- Whether people may reply. Some notices invite it; a bereavement notice
  -- does not, and switching it off is kinder than moderating afterwards.
  comments_enabled boolean NOT NULL DEFAULT true,

  author_id   uuid NOT NULL REFERENCES core_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT hr_announcements_status_check
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  -- A window that ends before it starts would be live for nobody and is
  -- certainly a mistake at the point it is typed.
  CONSTRAINT hr_announcements_window_check
    CHECK (expires_at IS NULL OR expires_at > publish_at),
  -- Something must be readable. All four text columns empty is an empty card.
  CONSTRAINT hr_announcements_has_title
    CHECK (COALESCE(title, title_ar) IS NOT NULL)
);

-- The home page's question: what is live right now, most important first.
-- Partial, because drafts and expired notices are the majority after a year and
-- none of them belong in that answer.
CREATE INDEX hr_announcements_live_idx
  ON hr_announcements (pinned DESC, publish_at DESC)
  WHERE status = 'PUBLISHED' AND deleted_at IS NULL;

-- The archive page, which does want the old ones.
CREATE INDEX hr_announcements_recent_idx
  ON hr_announcements (publish_at DESC) WHERE deleted_at IS NULL;

/* ------------------------------------------------------------------ images */
-- The same two-step upload the ticket attachments use: a row is created first,
-- the browser puts the bytes straight into S3, and the row only becomes READY
-- once the API has looked at what actually arrived. A row that never gets
-- confirmed is an abandoned upload and is simply never shown.

CREATE TABLE hr_announcement_images (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES hr_announcements(id) ON DELETE CASCADE,

  status          text NOT NULL DEFAULT 'PENDING',
  incoming_key    text,
  file_key        text,
  thumb_key       text,
  content_type    text,
  original_name   text,
  bytes           bigint,
  width           integer,
  height          integer,

  -- The order HR arranged them in, which is not the order they were uploaded.
  position        integer NOT NULL DEFAULT 0,
  caption         text,
  caption_ar      text,

  uploaded_by     uuid NOT NULL REFERENCES core_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,
  deleted_at      timestamptz,

  CONSTRAINT hr_announcement_images_status_check
    CHECK (status IN ('PENDING', 'READY', 'DELETED')),
  -- A READY row without its object is a broken picture on the home page; the
  -- constraint makes that state impossible rather than merely unlikely.
  CONSTRAINT hr_announcement_images_ready_is_complete
    CHECK (status <> 'READY' OR (file_key IS NOT NULL AND content_type IS NOT NULL))
);

CREATE INDEX hr_announcement_images_live_idx
  ON hr_announcement_images (announcement_id, position)
  WHERE status = 'READY' AND deleted_at IS NULL;

/* ---------------------------------------------------------------- comments */

CREATE TABLE hr_announcement_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES hr_announcements(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES core_users(id),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Kept as a row when removed, so a thread does not silently reshuffle under
  -- the people reading it and so an author can be answered for what they said.
  deleted_at      timestamptz,
  deleted_by_id   uuid REFERENCES core_users(id),

  CONSTRAINT hr_announcement_comments_body_check
    CHECK (length(btrim(body)) > 0)
);

CREATE INDEX hr_announcement_comments_thread_idx
  ON hr_announcement_comments (announcement_id, created_at)
  WHERE deleted_at IS NULL;

/* ------------------------------------------------------------- permissions */
-- One permission, not a department check. HR owns this in practice, but
-- "whoever is in HR" is the wrong rule to write into the code: the day the
-- operations manager needs to post a notice about the lift being out, the
-- answer should be to grant them a permission, not to move them into HR.

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('announcements.manage', 'announcements',
   'Write, publish and take down company announcements, and remove comments on them')
ON CONFLICT (key) DO NOTHING;