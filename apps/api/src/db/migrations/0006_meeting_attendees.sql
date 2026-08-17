-- 0006_meeting_attendees.sql
-- Inviting colleagues to a meeting, and having it reach their home screen.
--
-- The attendees table has existed since 0004 and the API already accepted
-- attendeeUserIds -- but nothing invited anyone, and more to the point the home
-- portlets asked `organizer_id = me`, so a meeting somebody else booked for you
-- was invisible. You could be invited and never find out.
--
-- Additive: one column, and the indexes the new "is this meeting mine in any
-- sense" lookups need.

-- When they answered. `response` alone cannot distinguish "has not looked yet"
-- from "looked and left it", which is the difference between chasing someone
-- and not.
ALTER TABLE mr_reservation_attendees
  ADD COLUMN IF NOT EXISTS responded_at timestamptz;

-- Existing rows that are not still INVITED must have been answered at some
-- point; there is no better timestamp available than the reservation's own.
UPDATE mr_reservation_attendees a
   SET responded_at = r.created_at
  FROM mr_reservations r
 WHERE r.id = a.reservation_id
   AND a.response <> 'INVITED'
   AND a.responded_at IS NULL;

-- "Which meetings am I in?" is now on the home screen of every employee, so it
-- runs constantly. The existing index on (user_id) serves the lookup; this one
-- serves it *with* the response, which is what the invitations portlet filters
-- on -- and it stays small because most rows are not INVITED for long.
CREATE INDEX IF NOT EXISTS mr_attendees_user_pending_idx
  ON mr_reservation_attendees (user_id) WHERE response = 'INVITED';
