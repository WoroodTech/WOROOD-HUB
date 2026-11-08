-- 0042_signup_requests.sql
-- People asking for an account, and the decision on each.
--
-- A request is not a user. It is kept in its own table rather than as a
-- `PENDING` row in `core_users`, because a pending row is a row every query
-- in the portal has to remember to exclude: a department head list, a task
-- assignee picker, an approver rail. Each one that forgot would show somebody
-- who does not work here yet, and the forgetting would be silent.
--
-- The account is created only when somebody approves, and then it is an
-- ordinary user from its first moment.

CREATE TABLE core_signup_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email         text NOT NULL,
  full_name     text NOT NULL,
  /* Hashed on arrival, never stored as typed. The request may sit for days,
     and a plain password waiting in a table is a plain password whatever
     happens to the request afterwards. */
  password_hash text NOT NULL,
  department_id uuid NOT NULL REFERENCES core_departments(id),

  status        text NOT NULL DEFAULT 'PENDING',

  decided_by_id uuid REFERENCES core_users(id),
  decided_at    timestamptz,
  /* Why it was refused, for the person who asked. Never shown for an
     approval, where there is nothing to explain. */
  reason        text,

  /* The account this became, so a decision can be traced to its user and an
     approval cannot quietly happen twice. */
  user_id       uuid REFERENCES core_users(id),

  requested_ip  text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT core_signup_requests_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),

  CONSTRAINT core_signup_requests_decision_is_complete CHECK (
    (status = 'PENDING') = (decided_at IS NULL)
    AND (status = 'PENDING') = (decided_by_id IS NULL)
  ),

  -- An approved request made an account; a pending or refused one did not.
  CONSTRAINT core_signup_requests_approved_has_user CHECK (
    (status = 'APPROVED') = (user_id IS NOT NULL)
  )
);

/*
 * One pending request per address.
 *
 * Without it, somebody pressing the button twice -- or a script pressing it a
 * thousand times -- fills the approvals screen with the same person, and the
 * reviewer has to work out which copy to act on.
 *
 * Decided requests are outside the index on purpose: a refusal should not
 * stop somebody asking again once whatever caused it is sorted out.
 */
CREATE UNIQUE INDEX core_signup_requests_one_pending
  ON core_signup_requests (lower(email))
  WHERE status = 'PENDING';

CREATE INDEX core_signup_requests_pending_idx
  ON core_signup_requests (created_at)
  WHERE status = 'PENDING';

/* ------------------------------------------------------ who decides -- */
-- A permission rather than a role.
--
-- There is no `hr` role in this portal — the roles are employee, executive,
-- finance, marketing, operations, customer-care and admin — so naming one
-- here would have meant inventing it and then explaining what else it grants.
-- A permission can be given to whoever actually does this work, from the
-- Administration screen, without changing anybody's role.
--
-- Granted to admin here. Anyone else who should review sign-ups gets it from
-- Administration.

INSERT INTO core_permissions (key, module_key, description)
VALUES ('core.signup.review', 'administration',
        'Review requests for new accounts, and approve or refuse them')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, description = EXCLUDED.description;

INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r
  CROSS JOIN core_permissions p
 WHERE r.key = 'admin'
   AND p.key = 'core.signup.review'
ON CONFLICT DO NOTHING;