-- 0002_meeting_rooms.sql
-- Module 1: Meeting Room Reservation System. Owns every mr_* table.
-- Present so the home dashboard renders a genuinely multi-module grid.

CREATE TABLE mr_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, name_ar text,
  iana_timezone text NOT NULL DEFAULT 'Africa/Cairo', address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mr_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES mr_locations(id),
  name text NOT NULL, name_ar text,
  capacity integer NOT NULL, floor text,
  status text NOT NULL DEFAULT 'ACTIVE',
  opens_at time NOT NULL DEFAULT '08:00',
  closes_at time NOT NULL DEFAULT '18:00',
  equipment text[] NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mr_rooms_status_idx ON mr_rooms (status) WHERE deleted_at IS NULL;

CREATE TABLE mr_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  room_id uuid NOT NULL REFERENCES mr_rooms(id),
  organizer_id uuid NOT NULL REFERENCES core_users(id),
  title text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED',
  attendees integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mr_reservations_time_order CHECK (ends_at > starts_at)
);

-- The double-booking guarantee. Enforced by the index itself, so concurrency,
-- process count and statement ordering cannot defeat it. '[)' means a meeting
-- ending at 10:00 and one starting at 10:00 do not clash. The WHERE clause
-- scopes it to live bookings, so cancelling frees the room with no cleanup.
ALTER TABLE mr_reservations
  ADD CONSTRAINT mr_reservations_no_overlap
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('PENDING','CONFIRMED'));

CREATE INDEX mr_reservations_room_time_idx ON mr_reservations (room_id, starts_at, ends_at);
CREATE INDEX mr_reservations_organizer_idx ON mr_reservations (organizer_id, starts_at DESC);

CREATE TRIGGER mr_rooms_updated BEFORE UPDATE ON mr_rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mr_reservations_updated BEFORE UPDATE ON mr_reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
