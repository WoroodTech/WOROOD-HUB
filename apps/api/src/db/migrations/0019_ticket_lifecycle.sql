-- 0018_ticket_lifecycle.sql
-- The lifecycle Worood actually runs.
--
-- 0017 modelled a ticket as raise → assign → work → resolve → confirm. What the
-- business does is longer, and three of the steps it was missing are the ones
-- managers spend their day in: a ticket parked for a date, a ticket parked for
-- a reason, and work handed back for the requester to look at before it counts
-- as finished.
--
--   NEW ──► PLANNING   (a date, no assignee yet)
--       ──► ON_HOLD    (a reason)
--       ──► ASSIGNED   (a person)
--
--   ASSIGNED ──► IN_PROGRESS ⇄ BLOCKED      (waiting on another department)
--                IN_PROGRESS ──► FOR_REVIEW
--                FOR_REVIEW  ──► IN_PROGRESS   (sent back, with a reason)
--                            ──► IMPLEMENTATION ──► DONE
--
-- `DONE` replaces `CLOSED`, and `FOR_REVIEW` replaces `RESOLVED`. The old names
-- described a state machine; these describe what somebody is waiting for, which
-- is what a person reading a board needs to know.
--
-- Two things are deliberately NOT statuses.
--
-- **Delayed.** It stays `sla_state`, a column beside the status, because a
-- ticket can be late *and* blocked and both facts matter: a manager who sees
-- only "delayed" asks the assignee why they have stopped, and the answer is
-- that they have not — they are waiting on another department. The board draws
-- a Delayed column from `sla_state = 'OVERDUE'` regardless of status, and the
-- card shows the real status underneath.
--
-- **Fast-tracked.** A flag set once at creation, not a status. It removes the
-- review step: IN_PROGRESS goes straight to IMPLEMENTATION. Kept as a column so
-- the board shape is the same either way, and so "how much work skipped review"
-- is answerable.

/* -------------------------------------------------------- the new states -- */

-- Existing rows first: the CHECK constraint cannot be replaced while data
-- violates it, and a live install already has tickets in the old vocabulary.
ALTER TABLE tk_items DROP CONSTRAINT IF EXISTS tk_items_status_check;
ALTER TABLE tk_items DROP CONSTRAINT IF EXISTS tk_items_assignee_matches_status;

UPDATE tk_items SET status = 'FOR_REVIEW' WHERE status = 'RESOLVED';
UPDATE tk_items SET status = 'DONE'       WHERE status = 'CLOSED';

ALTER TABLE tk_items ADD CONSTRAINT tk_items_status_check CHECK (
  status IN ('NEW','PLANNING','ON_HOLD','ASSIGNED','IN_PROGRESS','BLOCKED',
             'FOR_REVIEW','IMPLEMENTATION','DONE','REJECTED','CANCELLED')
);

/* ------------------------------------------------------------- new fields -- */

-- When the manager intends the work to happen. A date without a person: the
-- assignee is chosen when the work actually starts, because naming somebody a
-- fortnight early only means reassigning them when the fortnight arrives.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS planned_for timestamptz;

-- Set once at creation, never afterwards -- see the trigger below. A ticket
-- that could be fast-tracked after the fact would be fast-tracked whenever
-- review became inconvenient, which is the same as not having review.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS fast_track boolean NOT NULL DEFAULT false;

-- What the requester said when they sent work back. Distinct from
-- `status_reason`, which is overwritten by the next transition: this is the
-- record of a refusal and has to survive the ticket moving on.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS review_rejected_reason text;
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS review_rejected_at timestamptz;
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS review_rejection_count integer NOT NULL DEFAULT 0;

-- The clock stops while a ticket waits on another department, and this is where
-- it is kept. Without it a ticket blocked for a week comes back a week overdue
-- through no fault of the person holding it, and the SLA figures describe the
-- queue rather than the work.
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS implementation_started_at timestamptz;
ALTER TABLE tk_items ADD COLUMN IF NOT EXISTS done_at timestamptz;

/* --------------------------------------------------------- the invariants -- */

-- Who must exist at which point. PLANNING and ON_HOLD are the new cases: both
-- are parked states with nobody holding them, which is exactly what makes them
-- worth having as statuses rather than as notes on a NEW ticket.
ALTER TABLE tk_items ADD CONSTRAINT tk_items_assignee_matches_status CHECK (
  (status IN ('NEW','PLANNING','ON_HOLD') AND assignee_id IS NULL)
  OR (status IN ('ASSIGNED','IN_PROGRESS','BLOCKED','FOR_REVIEW','IMPLEMENTATION')
      AND assignee_id IS NOT NULL)
  OR status IN ('DONE','REJECTED','CANCELLED')
);

-- A parked ticket says why or when. "On hold" with no sentence is how a queue
-- fills with tickets nobody can explain, and a planned date is the entire point
-- of planning.
ALTER TABLE tk_items ADD CONSTRAINT tk_items_parked_is_explained CHECK (
  status <> 'ON_HOLD'  OR length(btrim(coalesce(status_reason,''))) > 0
);
ALTER TABLE tk_items ADD CONSTRAINT tk_items_planning_has_date CHECK (
  status <> 'PLANNING' OR planned_for IS NOT NULL
);

-- Work sent back carries the reason with it, for as long as the ticket exists.
ALTER TABLE tk_items ADD CONSTRAINT tk_items_review_rejection_has_reason CHECK (
  review_rejected_at IS NULL OR length(btrim(coalesce(review_rejected_reason,''))) > 0
);

/* Fast-track is decided at creation and not after.
 *
 * A constraint cannot express "only on INSERT", so it is a trigger. Enforced in
 * the database rather than in the service because the rule is about what the
 * flag *means*: a ticket whose review requirement can be removed mid-flight has
 * no review requirement, and the value of the column depends on that being
 * impossible rather than merely discouraged. */
CREATE OR REPLACE FUNCTION tk_items_fast_track_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fast_track IS DISTINCT FROM OLD.fast_track THEN
    RAISE EXCEPTION 'fast_track is decided when the ticket is raised and cannot be changed afterwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tk_items_fast_track_lock ON tk_items;
CREATE TRIGGER tk_items_fast_track_lock
  BEFORE UPDATE ON tk_items
  FOR EACH ROW EXECUTE FUNCTION tk_items_fast_track_is_immutable();

/* ----------------------------------------------------- dependency tickets -- */

-- A dependency raises a real ticket in the other department: it is planned,
-- assigned, worked and reviewed like any other, because that is what it is.
-- What makes it a dependency is this row pointing at what is waiting for it,
-- and 0017's tk_links already carries that -- including the cycle check.
--
-- Two columns are added there. `requested_by_department_id` because the board
-- needs to show "this came from Marketing" without a join through the parent,
-- and the response fields because a department can refuse.
ALTER TABLE tk_links ADD COLUMN IF NOT EXISTS response text
  CHECK (response IN ('PENDING','ACCEPTED','REJECTED'));
ALTER TABLE tk_links ADD COLUMN IF NOT EXISTS response_reason text;
ALTER TABLE tk_links ADD COLUMN IF NOT EXISTS responded_at timestamptz;
ALTER TABLE tk_links ADD COLUMN IF NOT EXISTS responded_by uuid REFERENCES core_users(id);

-- Existing links predate the idea of accepting one, so they are treated as
-- accepted: they were created by somebody who meant them.
UPDATE tk_links SET response = 'ACCEPTED'
 WHERE response IS NULL AND link_type = 'BLOCKED_BY';

/* --------------------------------------------------------------- indexes -- */

-- The manager board reads by department and status; the columns are the
-- statuses, so this is the query behind every screen in the module.
CREATE INDEX IF NOT EXISTS tk_items_board_idx
  ON tk_items (department_id, status, planned_for);

-- The requesting department's view of work it has asked for -- the other half
-- of the board, and the one 0017 had no index for.
CREATE INDEX IF NOT EXISTS tk_items_requesting_dept_idx
  ON tk_items (requester_department_id, status, created_at DESC);

-- Planning is a calendar: a manager asks what is planned for this week.
CREATE INDEX IF NOT EXISTS tk_items_planned_idx
  ON tk_items (department_id, planned_for)
  WHERE status = 'PLANNING';

-- The sweep that sets OVERDUE now has more live states to consider, and must
-- skip BLOCKED: a ticket waiting on another department is not late.
DROP INDEX IF EXISTS tk_items_due_idx;
CREATE INDEX tk_items_due_idx
  ON tk_items (due_at)
  WHERE due_at IS NOT NULL
    AND status IN ('ASSIGNED','IN_PROGRESS','FOR_REVIEW','IMPLEMENTATION');