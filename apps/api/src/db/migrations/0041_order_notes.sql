-- 0041_order_notes.sql
-- Notes staff add to an order, kept here and mirrored into Shopify.
--
-- **Why both.** Shopify cannot be told to add a timeline comment: the
-- CommentEvent object is read-only in the Admin API, and no mutation creates
-- one. The only writable field is the order's `note`, and changing it does
-- appear in the timeline -- as a note-changed event carrying the new text
-- rather than as a comment from a named person.
--
-- But `note` is one string, not a list. Writing it replaces whatever was
-- there, so a second person's note would erase the first unless the whole
-- thing is read, appended to and written back. That makes Shopify a place to
-- publish to, and a poor place to keep anything:
--
--   - there is no author on a line, only whatever text was typed into it
--   - a single note cannot be edited or removed without rewriting all of them
--   - it grows without limit and cannot be searched
--
-- So the notes live here, one row each, with who wrote them and when; and the
-- order's Shopify note is rebuilt from those rows after every change. The
-- timeline then shows the current set, and the portal keeps the history.

CREATE TABLE sd_order_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES sd_orders(id) ON DELETE CASCADE,

  body        text NOT NULL,
  author_id   uuid NOT NULL REFERENCES core_users(id),

  /* Soft-deleted, because a note that reached Shopify was read by somebody,
     and the record of what was published is worth keeping even after it is
     withdrawn. Removed notes are left out when the Shopify note is rebuilt. */
  deleted_at  timestamptz,
  deleted_by_id uuid REFERENCES core_users(id),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sd_order_notes_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT sd_order_notes_deletion_is_complete CHECK (
    (deleted_at IS NULL) = (deleted_by_id IS NULL)
  )
);

CREATE INDEX sd_order_notes_order_idx
  ON sd_order_notes (order_id, created_at)
  WHERE deleted_at IS NULL;

/* ------------------------------------------------ publishing to Shopify -- */
-- What the order's note in Shopify currently says, as far as we know, and
-- whether that still matches the rows above.
--
-- Kept per order rather than per note because Shopify holds one field: the
-- unit of publishing is the whole note, not a line of it.

ALTER TABLE sd_orders
  ADD COLUMN IF NOT EXISTS notes_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS notes_publish_error text,
  /* The text last successfully written. Compared before writing, so a retry
     that would change nothing makes no call -- and so an order edited in
     Shopify Admin by hand can be noticed rather than silently overwritten. */
  ADD COLUMN IF NOT EXISTS notes_published_body text;

COMMENT ON COLUMN sd_orders.notes_published_body IS
  'The note text we last wrote to Shopify. If the order''s note there differs '
  'from this, somebody edited it in the Admin and the difference is theirs, '
  'not ours.';

/* ------------------------------------------------------- who may write -- */
-- Granted here rather than in `seed.ts`, which is not an option on a live
-- database: it deletes every role's permissions before re-inserting them, so
-- running it would revert every grant made by hand since launch.
--
-- Finance holds it because they are the team reconciling payments against
-- orders, and what they find there is what the rest of the company needs to
-- see on the order itself.

INSERT INTO core_permissions (key, module_key, description)
VALUES ('sales.order.note.write', 'sales-dashboard',
        'Add notes to an order, published to its Shopify timeline')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, description = EXCLUDED.description;

/*
 * Granted to whichever of these roles already exist.
 *
 * On a live database that is both of them, which is the case this is for. On
 * a database built from scratch it is neither -- migrations run before the
 * seed, and the seed is what creates the roles -- so nothing is written here
 * and the seed's own list is what grants it. Both paths end up the same; only
 * this one is safe to run on a database with real data in it.
 *
 * (The seed cannot be used on a live database: it deletes every role's
 * permissions before re-inserting them, reverting every grant made by hand
 * since launch.)
 */
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r
  CROSS JOIN core_permissions p
 WHERE r.key IN ('finance', 'admin')
   AND p.key = 'sales.order.note.write'
ON CONFLICT DO NOTHING;