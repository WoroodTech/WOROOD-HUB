-- ===========================================================================
-- WOROOD HUB — Migration 0002: Meeting Rooms module
-- ---------------------------------------------------------------------------
-- All tables are prefixed mr_. Dropping this file's objects removes the whole
-- module without touching the platform.
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE room_status AS ENUM ('ACTIVE', 'MAINTENANCE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attendee_response AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Sites / buildings
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       varchar(32)  NOT NULL UNIQUE,
  name       varchar(160) NOT NULL,
  name_ar    varchar(160),
  building   varchar(120),
  address    varchar(255),
  timezone   varchar(64)  NOT NULL DEFAULT 'Africa/Cairo',
  created_at timestamptz  NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Equipment catalogue (projector, VC unit, whiteboard, ...)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_equipment (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key     varchar(48)  NOT NULL UNIQUE,
  name    varchar(120) NOT NULL,
  name_ar varchar(120),
  icon    varchar(48)
);

-- --------------------------------------------------------------------------
-- Rooms. Booking policy lives on the row so Facilities can change the rules
-- from the admin screen without a code deploy.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_rooms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 varchar(32)  NOT NULL UNIQUE,
  name                 varchar(160) NOT NULL,
  name_ar              varchar(160),
  location_id          uuid NOT NULL REFERENCES mr_locations(id) ON DELETE RESTRICT,
  floor                varchar(48),
  capacity             integer      NOT NULL CHECK (capacity > 0),
  description          varchar(1000),
  photo_url            varchar(255),
  status               room_status  NOT NULL DEFAULT 'ACTIVE',
  opening_time         time         NOT NULL DEFAULT '07:00',
  closing_time         time         NOT NULL DEFAULT '20:00',
  slot_minutes         integer      NOT NULL DEFAULT 30  CHECK (slot_minutes BETWEEN 5 AND 120),
  min_duration_minutes integer      NOT NULL DEFAULT 30  CHECK (min_duration_minutes > 0),
  max_duration_minutes integer      NOT NULL DEFAULT 480 CHECK (max_duration_minutes > 0),
  max_advance_days     integer      NOT NULL DEFAULT 90  CHECK (max_advance_days > 0),
  buffer_minutes       integer      NOT NULL DEFAULT 0   CHECK (buffer_minutes >= 0),
  requires_approval    boolean      NOT NULL DEFAULT false,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT mr_rooms_duration_order CHECK (max_duration_minutes >= min_duration_minutes),
  CONSTRAINT mr_rooms_hours_order    CHECK (closing_time > opening_time)
);
CREATE INDEX IF NOT EXISTS mr_rooms_location_idx ON mr_rooms (location_id);
CREATE INDEX IF NOT EXISTS mr_rooms_status_idx   ON mr_rooms (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mr_rooms_capacity_idx ON mr_rooms (capacity);

DROP TRIGGER IF EXISTS mr_rooms_updated_at ON mr_rooms;
CREATE TRIGGER mr_rooms_updated_at BEFORE UPDATE ON mr_rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS mr_room_equipment (
  room_id      uuid NOT NULL REFERENCES mr_rooms(id)     ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES mr_equipment(id) ON DELETE CASCADE,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (room_id, equipment_id)
);

-- --------------------------------------------------------------------------
-- Blackout windows (maintenance, public holidays). Availability treats these
-- exactly like a booking.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_room_blackouts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES mr_rooms(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mr_blackouts_time_order CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS mr_blackouts_room_time_idx
  ON mr_room_blackouts (room_id, starts_at, ends_at);

-- --------------------------------------------------------------------------
-- Reservations
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           varchar(24)  NOT NULL UNIQUE,
  room_id             uuid NOT NULL REFERENCES mr_rooms(id)  ON DELETE RESTRICT,
  organizer_id        uuid NOT NULL REFERENCES core_users(id) ON DELETE RESTRICT,
  title               varchar(190) NOT NULL,
  description         varchar(2000),
  starts_at           timestamptz  NOT NULL,
  ends_at             timestamptz  NOT NULL,
  attendee_count      integer      NOT NULL DEFAULT 1 CHECK (attendee_count > 0),
  status              reservation_status NOT NULL DEFAULT 'CONFIRMED',
  cancelled_by_id     uuid REFERENCES core_users(id) ON DELETE SET NULL,
  cancelled_at        timestamptz,
  cancellation_reason varchar(500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mr_reservations_time_order CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS mr_reservations_room_time_idx  ON mr_reservations (room_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS mr_reservations_organizer_idx  ON mr_reservations (organizer_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS mr_reservations_status_idx     ON mr_reservations (status, starts_at);

DROP TRIGGER IF EXISTS mr_reservations_updated_at ON mr_reservations;
CREATE TRIGGER mr_reservations_updated_at BEFORE UPDATE ON mr_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ***************************************************************************
-- THE DOUBLE-BOOKING GUARANTEE
-- ---------------------------------------------------------------------------
-- An application-level "check then insert" is a race: two requests can both
-- pass the check before either writes. This GiST exclusion constraint makes
-- the rule an invariant of the database itself — the second concurrent
-- transaction is rejected by PostgreSQL, not by our code. It applies only to
-- live bookings, so cancelled reservations never block a room, and the same
-- index also accelerates availability lookups.
--
-- '[)' = half-open range, so a meeting ending 10:00 and one starting 10:00
-- are NOT considered overlapping.
-- ***************************************************************************
ALTER TABLE mr_reservations DROP CONSTRAINT IF EXISTS mr_reservations_no_overlap;
ALTER TABLE mr_reservations
  ADD CONSTRAINT mr_reservations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('PENDING', 'CONFIRMED'));

-- --------------------------------------------------------------------------
-- Attendees — either an internal user or an external guest e-mail
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_reservation_attendees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES mr_reservations(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES core_users(id) ON DELETE CASCADE,
  external_email varchar(190),
  external_name  varchar(160),
  response       attendee_response NOT NULL DEFAULT 'INVITED',
  CONSTRAINT mr_attendee_identity CHECK (
    (user_id IS NOT NULL AND external_email IS NULL) OR
    (user_id IS NULL AND external_email IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS mr_attendees_unique_user
  ON mr_reservation_attendees (reservation_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mr_attendees_user_idx ON mr_reservation_attendees (user_id);
