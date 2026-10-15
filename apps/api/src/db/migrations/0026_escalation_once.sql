-- 0026_escalation_once.sql
-- One escalation per ticket, enforced by the database.
--
-- The unassigned-escalation sweep notified every manager in a department and
-- the one above it, then wrote an ESCALATED event so it would not do so again.
-- The guard against repeating was "no such event exists yet" -- a condition
-- evaluated inside the same statement that inserts.
--
-- That is not exclusion. Under READ COMMITTED two schedulers running the sweep
-- in the same second each evaluate NOT EXISTS against their own snapshot,
-- before either has committed, and both find nothing. Both insert, and both
-- notify: the message saying "nobody has picked this up" arrives twice, from
-- the system that is meant to be the calm one. Tested, and it happens --
-- reliably, not as a rare race.
--
-- A partial unique index is what actually decides it. The second insert
-- violates it, ON CONFLICT DO NOTHING swallows it, and the loser gets no row
-- back and sends nothing.

-- Existing duplicates must go first, or the index cannot be built. These are
-- the bug's output: the earliest is the real escalation and the rest are
-- repeats of it, so the earliest is kept.
DELETE FROM tk_events e
 USING tk_events keep
 WHERE e.type = 'ESCALATED'
   AND keep.type = 'ESCALATED'
   AND keep.item_id = e.item_id
   AND (keep.created_at < e.created_at
        OR (keep.created_at = e.created_at AND keep.id < e.id));

CREATE UNIQUE INDEX IF NOT EXISTS tk_events_escalated_once_idx
  ON tk_events (item_id) WHERE type = 'ESCALATED';

COMMENT ON INDEX tk_events_escalated_once_idx IS
  'One ESCALATED event per ticket. What makes the escalation sweep safe to run on more than one instance.';