-- 0039_announcement_reactions.sql
-- Saying something about a notice without writing a comment.
--
-- Comments already exist, and they are the wrong size for most of what people
-- want to say. Somebody who has read the holiday notice has nothing to add to
-- it; somebody pleased about an award wants to say so without being the one
-- person who left a message. Both currently say nothing at all, and the board
-- looks unread.
--
-- The set is fixed, and stored by name rather than by glyph. A name survives
-- the day somebody wants a different picture for "seen", lets the same choice
-- be labelled in another language, and keeps a surprise codepoint out of the
-- column. Fixed rather than open because the counts are only worth reading
-- while they stay a handful: spread across forty symbols, "how did this land"
-- stops having an answer.

CREATE TABLE hr_announcement_reactions (
  announcement_id uuid NOT NULL
    REFERENCES hr_announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,

  -- One of a fixed set, named rather than stored as the character itself:
  -- a name survives the day somebody wants a different glyph for "seen",
  -- and it cannot carry a surprise codepoint into the column.
  kind            text NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One reaction per person per notice. Changing your mind replaces it rather
  -- than adding to it, so the counts stay a count of people.
  PRIMARY KEY (announcement_id, user_id),

  CONSTRAINT hr_announcement_reactions_kind_check
    CHECK (kind IN ('seen', 'like', 'love', 'celebrate', 'clap',
                    'thanks', 'funny', 'sad', 'curious'))
);

CREATE INDEX hr_announcement_reactions_counting_idx
  ON hr_announcement_reactions (announcement_id, kind);

COMMENT ON TABLE hr_announcement_reactions IS
  'One reaction per person per notice. Replacing is how you change your mind, '
  'which keeps every count a count of people rather than of clicks.';