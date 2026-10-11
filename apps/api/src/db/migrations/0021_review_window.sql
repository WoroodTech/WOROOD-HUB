-- 0021_review_window.sql
-- Two states the lifecycle was missing, and a clock on review.
--
-- APPROVED and CHANGES_REQUESTED were decisions the requester made that the
-- board could not show. Approving moved a ticket straight to IMPLEMENTATION, so
-- "they said yes" and "the assignee has started putting it in place" were the
-- same column -- and a rejection landed back in IN_PROGRESS, where it looked
-- like ordinary work rather than work that had been sent back. Both are now
-- states a card can rest in, which is what makes them visible.
--
--   FOR_REVIEW --approve--> APPROVED          --assignee--> IMPLEMENTATION
--              --reject---> CHANGES_REQUESTED --assignee--> IN_PROGRESS
--
-- Fast-tracked work skips the asking but not the state: it goes to APPROVED
-- directly, because the step that is skipped is the requester's judgement, not
-- the assignee's run-up to carrying it out.

ALTER TABLE tk_items DROP CONSTRAINT IF EXISTS tk_items_status_check;
ALTER TABLE tk_items DROP CONSTRAINT IF EXISTS tk_items_assignee_matches_status;

ALTER TABLE tk_items ADD CONSTRAINT tk_items_status_check CHECK (
  status IN ('NEW','PLANNING','ON_HOLD','ASSIGNED','IN_PROGRESS','BLOCKED',
             'FOR_REVIEW','CHANGES_REQUESTED','APPROVED','IMPLEMENTATION',
             'DONE','REJECTED','CANCELLED')
);

-- Both new states belong to somebody: they are waiting on the assignee to act.
ALTER TABLE tk_items ADD CONSTRAINT tk_items_assignee_matches_status CHECK (
  (status IN ('NEW','PLANNING','ON_HOLD') AND assignee_id IS NULL)
  OR (status IN ('ASSIGNED','IN_PROGRESS','BLOCKED','FOR_REVIEW',
                 'CHANGES_REQUESTED','APPROVED','IMPLEMENTATION')
      AND assignee_id IS NOT NULL)
  OR status IN ('DONE','REJECTED','CANCELLED')
);

/* ------------------------------------------------------- the review clock -- */

-- When the review itself is late.
--
-- A ticket submitted for review stops being the assignee's problem and becomes
-- the requester's, and until now nothing counted that time. Work sat finished
-- and unlooked-at for days while the board showed it as on time, because the
-- only clock measured the assignee's due date -- which was already met.
--
-- The window is set when the ticket enters FOR_REVIEW, from its priority:
-- urgent 2 hours, high 4, normal 6, low 8. Cleared when it leaves, so a ticket
-- that comes back for a second review gets a fresh window rather than
-- inheriting an expired one.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS review_due_at timestamptz;

-- Which clock ran out. The board draws one Delayed column, and a manager
-- looking at it needs to know whether the work is late or the *looking* at it
-- is -- those need two different conversations with two different people.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS sla_reason text
  CHECK (sla_reason IS NULL OR sla_reason IN ('WORK','REVIEW'));

-- The sweep reads this every few minutes: only rows waiting on a review that
-- has a deadline.
CREATE INDEX IF NOT EXISTS tk_items_review_due_idx
  ON tk_items (review_due_at)
  WHERE review_due_at IS NOT NULL AND status = 'FOR_REVIEW';

-- Existing rows predate the column; anything already late is late for work.
UPDATE tk_items SET sla_reason = 'WORK'
 WHERE sla_state = 'OVERDUE' AND sla_reason IS NULL;