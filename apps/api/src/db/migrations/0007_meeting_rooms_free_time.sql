-- 0007_meeting_rooms_free_time.sql
-- Booking moves from a per-room slot grid to a freely chosen start and length.
--
-- Why this is a new file rather than an edit to 0004: the runner records a
-- SHA-256 of every applied migration and refuses to start if one changes.
-- 0004 is deployed; removing its columns is a forward step, not a rewrite.
--
-- What goes away, and why it was there. `slot_minutes` generated the candidate
-- start times an employee could pick from -- there is no candidate list any
-- more, they type a time. `min_duration_minutes` and `max_duration_minutes`
-- were per-room policy; the rule is now one system-wide floor and ceiling
-- (10 and 480 minutes, in BOOKING_LIMITS) because tying a 20-minute stand-up
-- to which room happens to be free is the constraint people were working
-- around rather than working with.
--
-- What stays, deliberately: `opens_at` / `closes_at` still bound the day,
-- `buffer_minutes` still exists (every room is at 0 today), `max_advance_days`
-- still bounds the horizon, and the GiST exclusion constraint from 0002 is
-- untouched -- it is still the only thing that actually guarantees two
-- meetings cannot share a room, and it never cared about the grid.

-- The CHECKs go first: dropping a column a constraint references would fail.
ALTER TABLE mr_rooms DROP CONSTRAINT IF EXISTS mr_rooms_slot_sane;
ALTER TABLE mr_rooms DROP CONSTRAINT IF EXISTS mr_rooms_duration_order;

ALTER TABLE mr_rooms DROP COLUMN IF EXISTS slot_minutes;
ALTER TABLE mr_rooms DROP COLUMN IF EXISTS min_duration_minutes;
ALTER TABLE mr_rooms DROP COLUMN IF EXISTS max_duration_minutes;

-- A floor at the database as well as at the API. The API rejects anything
-- under ten minutes with a readable message; this is the backstop for a direct
-- INSERT, and it is the one duration rule that is now a property of the data
-- rather than of a room.
DO $$ BEGIN
  ALTER TABLE mr_reservations ADD CONSTRAINT mr_reservations_min_duration
    CHECK (ends_at >= starts_at + interval '10 minutes');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;