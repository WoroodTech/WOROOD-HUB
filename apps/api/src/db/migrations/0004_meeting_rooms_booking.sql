-- 0004_meeting_rooms_booking.sql
-- Module 1, brought from portlet depth to the full booking flow.
--
-- Everything here is ADDITIVE. No existing column is renamed, retyped or
-- dropped while it still holds data, because 0002 is already deployed and the
-- portlet queries, the seed and the exclusion constraint all read those columns
-- today. A migration that renames `attendees` to `attendee_count` would buy
-- tidiness and cost a working home screen; the API does the renaming instead,
-- at the boundary, where renaming is free.
--
-- The one destructive step is mr_rooms.equipment (text[]), and it is deferred:
-- the rows are copied into the catalogue first, and the column is dropped only
-- after, in the same transaction.

-- --------------------------------------------------------------------------
-- Locations: a stable short code, and the building an employee would say out
-- loud ("Tower B") rather than the row's UUID.
-- --------------------------------------------------------------------------
ALTER TABLE mr_locations ADD COLUMN IF NOT EXISTS code     varchar(32);
ALTER TABLE mr_locations ADD COLUMN IF NOT EXISTS building varchar(120);

UPDATE mr_locations
   SET code = upper(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE code IS NULL;

ALTER TABLE mr_locations ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mr_locations_code_key ON mr_locations (code);

-- --------------------------------------------------------------------------
-- Equipment catalogue. Normalised out of the text[] on mr_rooms so that
-- "which rooms have a VC unit" is an indexed join rather than an array scan,
-- and so Facilities can rename "Video Conference" once instead of in every row.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_equipment (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key     varchar(48)  NOT NULL UNIQUE,
  name    varchar(120) NOT NULL,
  name_ar varchar(120),
  icon    varchar(48)
);

CREATE TABLE IF NOT EXISTS mr_room_equipment (
  room_id      uuid NOT NULL REFERENCES mr_rooms(id)     ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES mr_equipment(id) ON DELETE CASCADE,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (room_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS mr_room_equipment_equipment_idx ON mr_room_equipment (equipment_id);

-- --------------------------------------------------------------------------
-- Rooms: identity, presentation, and booking policy.
--
-- Policy lives on the row, not in the code, so Facilities can shorten the
-- minimum booking or add a changeover buffer from the admin screen without a
-- deploy. The defaults reproduce the behaviour the module had before this
-- migration, so every existing room keeps working unchanged.
-- --------------------------------------------------------------------------
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS code        varchar(32);
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS description varchar(1000);
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS photo_url   varchar(255);

ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS slot_minutes         integer NOT NULL DEFAULT 30;
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS min_duration_minutes integer NOT NULL DEFAULT 30;
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS max_duration_minutes integer NOT NULL DEFAULT 480;
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS max_advance_days     integer NOT NULL DEFAULT 90;
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS buffer_minutes       integer NOT NULL DEFAULT 0;
ALTER TABLE mr_rooms ADD COLUMN IF NOT EXISTS requires_approval    boolean NOT NULL DEFAULT false;

UPDATE mr_rooms
   SET code = upper(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE code IS NULL;

ALTER TABLE mr_rooms ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mr_rooms_code_key ON mr_rooms (code);

DO $$ BEGIN
  ALTER TABLE mr_rooms ADD CONSTRAINT mr_rooms_status_known
    CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'INACTIVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_rooms ADD CONSTRAINT mr_rooms_slot_sane
    CHECK (slot_minutes BETWEEN 5 AND 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_rooms ADD CONSTRAINT mr_rooms_duration_order
    CHECK (max_duration_minutes >= min_duration_minutes AND min_duration_minutes > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_rooms ADD CONSTRAINT mr_rooms_hours_order
    CHECK (closes_at > opens_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_rooms ADD CONSTRAINT mr_rooms_buffer_sane
    CHECK (buffer_minutes BETWEEN 0 AND 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS mr_rooms_capacity_idx ON mr_rooms (capacity);

-- Copy the text[] into the catalogue, then retire the column. Order matters.
DO $$
DECLARE has_array boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'mr_rooms' AND column_name = 'equipment'
  ) INTO has_array;

  IF has_array THEN
    INSERT INTO mr_equipment (key, name)
    SELECT DISTINCT
           lower(regexp_replace(e, '[^a-zA-Z0-9]+', '-', 'g')),
           initcap(replace(e, '-', ' '))
      FROM mr_rooms r, unnest(r.equipment) AS e
     WHERE e IS NOT NULL AND e <> ''
    ON CONFLICT (key) DO NOTHING;

    INSERT INTO mr_room_equipment (room_id, equipment_id, quantity)
    SELECT r.id, q.id, 1
      FROM mr_rooms r, unnest(r.equipment) AS e
      JOIN mr_equipment q ON q.key = lower(regexp_replace(e, '[^a-zA-Z0-9]+', '-', 'g'))
    ON CONFLICT DO NOTHING;

    ALTER TABLE mr_rooms DROP COLUMN equipment;
  END IF;
END $$;

-- A small starting catalogue, so an empty install still offers something to
-- filter by. Anything the text[] already contained is preserved above.
INSERT INTO mr_equipment (key, name, name_ar, icon) VALUES
  ('projector',         'Projector',        'جهاز عرض',        'video'),
  ('video-conference',  'Video conference', 'اجتماع مرئي',      'users'),
  ('whiteboard',        'Whiteboard',       'سبورة',           'edit'),
  ('display',           'Wall display',     'شاشة',            'monitor'),
  ('speakerphone',      'Speakerphone',     'هاتف مؤتمرات',    'phone'),
  ('accessible',        'Step-free access', 'وصول ميسر',       'accessible')
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------------
-- Blackout windows: maintenance, deep cleans, public holidays. Availability
-- treats one exactly like a booking, which is why it is a separate table
-- rather than a fake reservation -- a blackout has no organiser to notify and
-- must never appear in anyone's "my reservations".
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
-- Reservations: description, and a cancellation that is recorded rather than
-- implied. Who cancelled it and why is the first thing anyone asks.
-- --------------------------------------------------------------------------
ALTER TABLE mr_reservations ADD COLUMN IF NOT EXISTS description         varchar(2000);
ALTER TABLE mr_reservations ADD COLUMN IF NOT EXISTS cancelled_by_id     uuid REFERENCES core_users(id) ON DELETE SET NULL;
ALTER TABLE mr_reservations ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz;
ALTER TABLE mr_reservations ADD COLUMN IF NOT EXISTS cancellation_reason varchar(500);

DO $$ BEGIN
  ALTER TABLE mr_reservations ADD CONSTRAINT mr_reservations_status_known
    CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_reservations ADD CONSTRAINT mr_reservations_time_order
    CHECK (ends_at > starts_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE mr_reservations ADD CONSTRAINT mr_reservations_attendees_positive
    CHECK (attendees > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS mr_reservations_status_idx ON mr_reservations (status, starts_at);

-- The human-facing booking reference. A sequence, not a COUNT(*)+1, because
-- two people booking at the same moment would otherwise be handed the same
-- number -- and a reference is what they read out on the phone.
CREATE SEQUENCE IF NOT EXISTS mr_reservation_reference_seq START WITH 2000;

-- --------------------------------------------------------------------------
-- Attendees: an internal user or an external guest, never both and never
-- neither -- the CHECK is what stops a half-filled row from existing at all.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mr_reservation_attendees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES mr_reservations(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES core_users(id) ON DELETE CASCADE,
  external_email varchar(190),
  external_name  varchar(160),
  response       varchar(16) NOT NULL DEFAULT 'INVITED',
  CONSTRAINT mr_attendee_response_known CHECK (response IN ('INVITED', 'ACCEPTED', 'DECLINED')),
  CONSTRAINT mr_attendee_identity CHECK (
    (user_id IS NOT NULL AND external_email IS NULL) OR
    (user_id IS NULL AND external_email IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS mr_attendees_unique_user
  ON mr_reservation_attendees (reservation_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mr_attendees_user_idx ON mr_reservation_attendees (user_id);
