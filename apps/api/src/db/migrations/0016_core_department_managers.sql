-- 0016_core_department_managers.sql
--
-- CORE PLATFORM CHANGE, not part of the tasks module.
--
-- core_departments has been a tree since 0001 and core_users has carried a
-- department since 0001, but nothing in the platform could answer "who runs
-- this department". Module 3 is the first thing that needs it; leave requests
-- and any approval flow will be the second and third.
--
-- A department may have more than one manager, deliberately. It is how cover
-- during leave works without handing anybody a company-wide role: both see the
-- queue, either may assign, and whoever assigns first wins.

CREATE TABLE core_department_managers (
  department_id uuid        NOT NULL REFERENCES core_departments(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES core_users(id)       ON DELETE RESTRICT,
  assigned_by   uuid            NULL REFERENCES core_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, user_id)
);

CREATE INDEX core_department_managers_user_idx
  ON core_department_managers (user_id);

COMMENT ON TABLE core_department_managers IS
  'Authority over a department''s work. A position in the org chart, not a '
  'role: a role would be company-wide and would let the Marketing manager '
  'assign work inside Customer Care.';

-- Every department at or below `root`. One place that knows how the tree is
-- walked, so no query anywhere reimplements it slightly differently.
CREATE OR REPLACE FUNCTION core_department_descendants(root uuid)
RETURNS TABLE (department_id uuid)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT id FROM core_departments WHERE id = root
    UNION            -- UNION, not UNION ALL: a malformed tree must not loop
    SELECT d.id FROM core_departments d JOIN tree t ON d.parent_id = t.id
  )
  SELECT id FROM tree;
$$;

-- Every department a person may act on: the ones they manage, plus everything
-- underneath those. This function is the whole of the manager scope rule and
-- the only thing any module should call to get it.
CREATE OR REPLACE FUNCTION core_user_managed_departments(p_user_id uuid)
RETURNS TABLE (department_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT dd.department_id
    FROM core_department_managers m
    CROSS JOIN LATERAL core_department_descendants(m.department_id) dd
   WHERE m.user_id = p_user_id;
$$;

-- Seed: give every existing department a manager so the module has somewhere
-- to send work from the first request, and so the "no department without a
-- manager" rail is true the moment it is enforced.
--
-- The pick is deterministic rather than arbitrary: the person in the
-- department whose job title reads like a lead, and failing that the
-- longest-standing member. Wrong in places, and it is meant to be replaced
-- from Administration -> Departments, which is a data change and not a deploy.
INSERT INTO core_department_managers (department_id, user_id)
SELECT d.id, pick.id
  FROM core_departments d
  JOIN LATERAL (
    SELECT u.id
      FROM core_users u
     WHERE u.department_id = d.id
       AND u.deleted_at IS NULL
       AND u.status = 'ACTIVE'
     -- COALESCE, not the bare column. A NULL job_title makes the expression
     -- NULL, and NULL sorts FIRST under DESC in PostgreSQL -- so an employee
     -- with no title recorded would be picked ahead of the actual manager.
     ORDER BY (COALESCE(u.job_title, '') ~* '(manager|director|head|lead|chief|officer)') DESC,
              u.created_at,
              u.id
     LIMIT 1
  ) AS pick ON true
ON CONFLICT DO NOTHING;

-- Rails enforced in the application, because they need context SQL does not
-- have (who is acting, and what to tell them to do first):
--   * removing the last manager of a department is refused, naming it;
--   * suspending or soft-deleting the last manager of a department is refused;
--   * a department with no manager never appears in the target picker.
-- ON DELETE RESTRICT above is the backstop for the second one only. These sit
-- alongside the existing last-administrator rails in the administration
-- module, and they fail the same way: by saying what to do first.
