-- 0017_tasks.sql
--
-- Module 3: Tasks & Tickets. Depends on 0016_core_department_managers.sql.
--
-- There is no `kind` column, and that is deliberate. A "task for myself" is a
-- ticket whose requester and assignee are the same person, and a "ticket for
-- my own department" is one whose target department is my own. One row shape,
-- one set of rules, one screen. Every branch we do not create here is a branch
-- that cannot drift.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE tk_item_reference_seq START 1001;

CREATE TABLE tk_items (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text        NOT NULL UNIQUE
                                      DEFAULT 'TK-' || nextval('tk_item_reference_seq'),

  title                   text        NOT NULL CHECK (length(btrim(title)) > 0),
  description             text,

  -- The requester states urgency; the assignee commits to a date. Two fields
  -- because they are two different people's opinions and merging them starts
  -- an argument on every ticket.
  priority                text        NOT NULL DEFAULT 'NORMAL'
                                      CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),

  status                  text        NOT NULL DEFAULT 'NEW'
                                      CHECK (status IN ('NEW','ASSIGNED','IN_PROGRESS','BLOCKED',
                                                        'RESOLVED','CLOSED','REJECTED','CANCELLED')),
  status_reason           text,
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  status_changed_by       uuid            NULL REFERENCES core_users(id),

  requester_id            uuid        NOT NULL REFERENCES core_users(id),
  -- Snapshot: people move between departments and a two-year-old ticket must
  -- still say which department asked.
  requester_department_id uuid            NULL REFERENCES core_departments(id),

  -- The department the work is being asked of. Never null: even a ticket you
  -- raise for yourself is addressed to your own department, which is what
  -- keeps your manager's queue honest.
  department_id           uuid        NOT NULL REFERENCES core_departments(id),

  assignee_id             uuid            NULL REFERENCES core_users(id),
  assigned_at             timestamptz,
  assigned_by             uuid            NULL REFERENCES core_users(id),

  due_at                  timestamptz,

  -- Lateness is a condition, not a status. A ticket can be IN_PROGRESS and
  -- OVERDUE at the same time, and that pair is the useful fact: it says where
  -- the work is *and* that it is late. Collapsing them into one column loses
  -- half of it.
  sla_state               text        NOT NULL DEFAULT 'ON_TIME'
                                      CHECK (sla_state IN ('ON_TIME','DUE_SOON','OVERDUE')),
  overdue_since           timestamptz,

  resolved_at             timestamptz,
  resolved_by             uuid            NULL REFERENCES core_users(id),
  closed_at               timestamptz,
  closed_by               uuid            NULL REFERENCES core_users(id),
  reopened_count          integer     NOT NULL DEFAULT 0,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- NEW means nobody has been picked yet; anything past it has an owner.
  -- This is the invariant that stops a ticket sitting in progress with no
  -- name against it.
  CONSTRAINT tk_items_assignee_matches_status CHECK (
    (status = 'NEW' AND assignee_id IS NULL)
    OR (status IN ('ASSIGNED','IN_PROGRESS','BLOCKED','RESOLVED') AND assignee_id IS NOT NULL)
    OR status IN ('CLOSED','REJECTED','CANCELLED')
  ),

  -- A refusal always says why. Both of these are somebody's work being sent
  -- back, and "rejected" with no sentence attached is how a system loses trust.
  CONSTRAINT tk_items_refusal_has_reason CHECK (
    status NOT IN ('REJECTED','CANCELLED') OR length(btrim(coalesce(status_reason,''))) > 0
  )
);

CREATE TRIGGER tk_items_set_updated_at
  BEFORE UPDATE ON tk_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The manager's "awaiting assignment" queue, which is the first number on
-- their screen. Partial, so it stays small however large the table grows.
CREATE INDEX tk_items_unassigned_idx
  ON tk_items (department_id, created_at)
  WHERE status = 'NEW';

CREATE INDEX tk_items_department_idx ON tk_items (department_id, status, created_at DESC);
CREATE INDEX tk_items_assignee_idx   ON tk_items (assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX tk_items_requester_idx  ON tk_items (requester_id, created_at DESC);

-- What the hourly sweep reads.
CREATE INDEX tk_items_due_idx
  ON tk_items (due_at)
  WHERE due_at IS NOT NULL AND status IN ('ASSIGNED','IN_PROGRESS','BLOCKED');

CREATE INDEX tk_items_late_idx
  ON tk_items (department_id, overdue_since)
  WHERE sla_state = 'OVERDUE';


-- Visibility is per ticket, not per department. This table IS the access list:
-- if you are not in it, and you do not manage the department, and you do not
-- hold view-any, the ticket does not exist as far as you are concerned.
-- One join answers "may this person see it", and the same rows are the
-- notification recipients, so the two can never disagree.
CREATE TABLE tk_participants (
  item_id     uuid        NOT NULL REFERENCES tk_items(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES core_users(id),

  --   REQUESTER      raised it. Edits freely before assignment, comments after,
  --                  accepts or rejects the resolution, closes it.
  --   ASSIGNEE       doing the work. Status, due date, dependencies, comments.
  --                  Never the title or description: those are the request.
  --   CONTRIBUTOR    added by a manager only. Reads and comments, nothing else.
  --   PAST_ASSIGNEE  worked on it before a reassignment. Read and comment.
  --   OBSERVER       the manager who transferred it away. Read only, so the
  --                  person who redirected it can still answer for it.
  role        text        NOT NULL
                          CHECK (role IN ('REQUESTER','ASSIGNEE','CONTRIBUTOR','PAST_ASSIGNEE','OBSERVER')),

  added_by    uuid            NULL REFERENCES core_users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),

  -- One person can hold two roles at once: a ticket you raise for yourself
  -- makes you both REQUESTER and ASSIGNEE.
  PRIMARY KEY (item_id, user_id, role)
);

CREATE INDEX tk_participants_user_idx ON tk_participants (user_id, role);


CREATE TABLE tk_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid        NOT NULL REFERENCES tk_items(id) ON DELETE CASCADE,
  author_id  uuid        NOT NULL REFERENCES core_users(id),
  body       text        NOT NULL CHECK (length(btrim(body)) > 0),
  edited_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tk_comments_set_updated_at
  BEFORE UPDATE ON tk_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX tk_comments_item_idx ON tk_comments (item_id, created_at)
  WHERE deleted_at IS NULL;


-- A dependency is a link between two ordinary tickets, never a special state
-- on one of them. The blocking ticket belongs to the other department in
-- every sense: its own requester, its own manager, its own assignee, its own
-- due date, its own queue.
CREATE TABLE tk_links (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id            uuid        NOT NULL REFERENCES tk_items(id) ON DELETE CASCADE,
  depends_on_item_id uuid        NOT NULL REFERENCES tk_items(id) ON DELETE RESTRICT,
  link_type          text        NOT NULL DEFAULT 'BLOCKED_BY'
                                 CHECK (link_type IN ('BLOCKED_BY','RELATED')),
  created_by         uuid        NOT NULL REFERENCES core_users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Set when the blocker closes or the link is removed. The row survives, so
  -- "it waited nine days on Design" is still answerable a month later.
  released_at        timestamptz,

  CONSTRAINT tk_links_not_self CHECK (item_id <> depends_on_item_id),
  UNIQUE (item_id, depends_on_item_id, link_type)
);

CREATE INDEX tk_links_blocker_idx
  ON tk_links (depends_on_item_id)
  WHERE released_at IS NULL AND link_type = 'BLOCKED_BY';

CREATE INDEX tk_links_item_idx ON tk_links (item_id) WHERE released_at IS NULL;

-- A depends on B, B depends on A, and both sit BLOCKED for ever with nobody
-- able to explain it. The database refuses the cycle rather than trusting
-- every call site to check for one.
CREATE OR REPLACE FUNCTION tk_links_reject_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.link_type <> 'BLOCKED_BY' OR NEW.released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- A BEFORE trigger runs ahead of the table's CHECK constraints, so
  -- tk_links_not_self would never get to speak. Say it here instead, because
  -- "waits on itself" reads like a fault in the system rather than a mistake
  -- in the request.
  IF NEW.item_id = NEW.depends_on_item_id THEN
    RAISE EXCEPTION 'a ticket cannot depend on itself'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE chain AS (
      SELECT NEW.item_id AS id
      UNION
      SELECT l.item_id
        FROM tk_links l
        JOIN chain c ON l.depends_on_item_id = c.id
       WHERE l.link_type = 'BLOCKED_BY' AND l.released_at IS NULL
    )
    SELECT 1 FROM chain WHERE id = NEW.depends_on_item_id
  ) THEN
    RAISE EXCEPTION 'circular dependency: % already waits on %',
      NEW.depends_on_item_id, NEW.item_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tk_links_no_cycle
  BEFORE INSERT OR UPDATE ON tk_links
  FOR EACH ROW EXECUTE FUNCTION tk_links_reject_cycle();


-- Append-only, and the source of three things at once: the timeline the
-- employee reads on the ticket, the notification fan-out, and the reporting.
-- Separate from core_audit_logs, which is security-shaped and actor-centric;
-- this one is ticket-shaped and readable.
CREATE TABLE tk_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid        NOT NULL REFERENCES tk_items(id) ON DELETE CASCADE,
  -- Null for the ones nobody did: the overdue sweep, the automatic unblock.
  actor_id   uuid            NULL REFERENCES core_users(id),
  type       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tk_events_item_idx ON tk_events (item_id, created_at);
CREATE INDEX tk_events_type_idx ON tk_events (type, created_at DESC);

COMMENT ON COLUMN tk_events.type IS
  'CREATED, ASSIGNED, REASSIGNED, TRANSFERRED, REJECTED, CONTRIBUTOR_ADDED, '
  'CONTRIBUTOR_REMOVED, STARTED, DUE_SET, DUE_CHANGED, COMMENTED, '
  'DEPENDENCY_ADDED, DEPENDENCY_RELEASED, BLOCKED, UNBLOCKED, RESOLVED, '
  'RESOLUTION_REJECTED, CLOSED, REOPENED, CANCELLED, OVERDUE, DUE_SOON';


/* ---------------------------------------------------------- permissions --

   Nothing in the application writes to core_permissions; only the seeder
   does. On a fresh install that is fine, because the seeder runs. On a LIVE
   install it is not: the seeder must never be run there -- it truncates, it
   rewrites role grants and it inserts the demonstration cast -- so without
   this block the module would land with its permission rows missing. Every
   route that declares a key would refuse everybody, including the
   administrator, and the Roles screen would list nothing to grant, leaving no
   way to fix it from inside the product.

   So the module registers its own keys here, additively and idempotently.
   ON CONFLICT DO NOTHING throughout, so this is a no-op on an install where
   the seeder has already run.                                              */

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('tasks.item.assign',     'tasks', 'Assign and redirect work in a department I manage'),
  ('tasks.item.view-any',   'tasks', 'Read every ticket in the company'),
  ('tasks.item.manage-any', 'tasks', 'Act on any ticket regardless of department'),
  ('tasks.report.view',     'tasks', 'Ticket reporting by department and ageing')
ON CONFLICT (key) DO NOTHING;

/* Nothing is granted to ordinary roles, and that is the point: raising a
   ticket and reading the ones you are on need no key at all. A role created
   from Administration -> Roles a year from now therefore works with the module
   out of the box, rather than silently missing a baseline somebody forgot. */

/* The administrator holds every key by definition, which is what makes the
   `admin` role able to see every ticket in every department without being a
   manager of any of them. Matched on the role key rather than on a count of
   permissions, so an install that renamed the role is simply skipped rather
   than having a guess made on its behalf. */
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core_roles r, core_permissions p
 WHERE r.key = 'admin' AND p.module_key = 'tasks'
ON CONFLICT DO NOTHING;

/* Deliberately NOT granted here: tasks.item.view-any to anyone else. Reading
   every ticket in the company is a decision about people, not a default, and
   Administration -> Roles is where it belongs -- one tick, no deployment.
   Note that tasks.item.assign is granted to nobody by this block either: it is
   derived in loadPrincipal from core_department_managers, because authority
   over a department is a position in the org chart rather than a role. The row
   exists above only so the Roles screen can explain it. */
