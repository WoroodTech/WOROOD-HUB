-- 0015_department_uniqueness.sql
-- Departments have been multiplying on every seed run.
--
-- The seeder inserts with `ON CONFLICT DO NOTHING` but names no conflict
-- target, and `core_departments.name` carries no unique constraint. Without a
-- target PostgreSQL checks only the constraints that exist -- which here is the
-- primary key on a generated uuid, never violated -- so nothing conflicts and
-- every run inserts another Customer Care, another Finance, another of each.
--
-- The seeder already reads back with `?? SELECT ... WHERE name = $1`, so it was
-- written expecting the insert to be a no-op. The expectation was right; the
-- constraint that makes it true was missing.
--
-- Two steps, and the order matters. Duplicates are merged before the index is
-- created, or creating it fails on the rows already there.

-- Point every user at the oldest row for their department name, so nobody is
-- reassigned to a different department by the cleanup -- only to the surviving
-- record of the same one.
UPDATE core_users u
   SET department_id = keep.id
  FROM core_departments d
  JOIN LATERAL (
    SELECT d2.id FROM core_departments d2
     WHERE d2.name = d.name
     ORDER BY d2.created_at, d2.id
     LIMIT 1
  ) AS keep ON true
 WHERE u.department_id = d.id
   AND keep.id <> d.id;

-- Same for the self-referencing tree, so a child does not end up parented to a
-- row that is about to disappear.
UPDATE core_departments c
   SET parent_id = keep.id
  FROM core_departments p
  JOIN LATERAL (
    SELECT p2.id FROM core_departments p2
     WHERE p2.name = p.name
     ORDER BY p2.created_at, p2.id
     LIMIT 1
  ) AS keep ON true
 WHERE c.parent_id = p.id
   AND keep.id <> p.id;

DELETE FROM core_departments d
 WHERE EXISTS (
   SELECT 1 FROM core_departments keep
    WHERE keep.name = d.name
      AND (keep.created_at, keep.id) < (d.created_at, d.id));

-- The constraint that makes the seeder's ON CONFLICT mean something. From here
-- a repeated seed updates nothing rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS core_departments_name_key
  ON core_departments (name);