# Administration: people, roles and dashboard access

August 2026. **Status: half built.** Dashboard assignment has a screen. People
and roles do not — they are SQL for now. This document says exactly where the
line falls and gives the SQL, rather than leaving it to be discovered.

## The model, in one paragraph

A **user** holds **roles**. A role carries **permissions** (`<module>.<entity>.<action>`).
Permissions gate *features* — whether the composer appears, whether you may
retire a room. **Dashboard access is separate**: a dashboard is granted to
*roles*, and then individual users can be **GRANT**ed or **REVOKE**d on top.
A REVOKE always wins over a role grant. Holding `sales.dashboard.manage` sees
every dashboard regardless, because administrators are identified by permission
rather than by a column.

So there are three independent questions, and they are answered in three
different places:

| Question | Where it lives | Manageable in the UI? |
|---|---|---|
| Which dashboards does this role/person get? | `sd_role_dashboard_access`, `sd_user_dashboard_access` | **Yes** — the composer |
| Which permissions does this role carry? | `core_role_permissions` | No — SQL |
| Which roles does this person hold? | `core_user_roles` | No — SQL |
| Does this person exist, and are they active? | `core_users` | No — SQL |

## What you can do in the portal today

**Sales → Manage Dashboards** (`/sales/admin`), then the **Access** control on a
dashboard. Requires `sales.dashboard.assign` or `sales.dashboard.manage` — the
`sales-admin` and `admin` roles have it.

There you set which roles receive the dashboard, and add individual people as an
explicit GRANT or REVOKE. That is the whole of dashboard assignment, and it is
audited: every change writes a `sales.dashboard.access_changed` row to
`core_audit_logs` with who did it and what changed.

Nothing else about a person is editable from the portal.

## Changes take effect immediately — with one caveat

`JwtAuthGuard` calls `loadPrincipal()` on **every request**, so permissions are
read fresh from the database each time. A role change is enforced by the API on
the very next call; nobody has to sign out.

The caveat is the portal, not the API. The sidebar comes from `/hub/modules`,
cached for five minutes, and the principal in the browser was captured at
sign-in. So someone whose role you change keeps *seeing* their old navigation for
up to five minutes — but clicking anything they no longer hold returns 403. Tell
them to reload, or have them sign out and in, and the screen catches up.

## The SQL

Every statement below was run against a real database before being written here.
Wrap them in `BEGIN; … COMMIT;` and check the `SELECT` first if you are nervous.

### Who has what right now

```sql
SELECT u.email, u.status, r.key AS role
  FROM core_users u
  LEFT JOIN core_user_roles ur ON ur.user_id = u.id
  LEFT JOIN core_roles r       ON r.id = ur.role_id
 WHERE u.deleted_at IS NULL
 ORDER BY u.email;
```

```sql
-- Which dashboards each role reaches, and the individual overrides on top.
SELECT d.key AS dashboard, string_agg(r.key, ', ' ORDER BY r.key) AS roles
  FROM sd_dashboards d
  LEFT JOIN sd_role_dashboard_access a ON a.dashboard_id = d.id
  LEFT JOIN core_roles r ON r.id = a.role_id
 GROUP BY d.key ORDER BY d.key;

SELECT u.email, d.key, a.effect
  FROM sd_user_dashboard_access a
  JOIN core_users u    ON u.id = a.user_id
  JOIN sd_dashboards d ON d.id = a.dashboard_id
 ORDER BY u.email;
```

### Change someone's role

Roles are a set, so a *replacement* is a delete then an insert. Deleting first is
the point — otherwise you have added a role rather than changed one.

```sql
BEGIN;
DELETE FROM core_user_roles
 WHERE user_id = (SELECT id FROM core_users WHERE email = 'omar.khaled@worood.co');

INSERT INTO core_user_roles (user_id, role_id)
SELECT u.id, r.id FROM core_users u, core_roles r
 WHERE u.email = 'omar.khaled@worood.co' AND r.key = 'sales-viewer';
COMMIT;
```

### Add a person

The password must be a bcrypt digest at the cost in `config.security.bcryptRounds`
(12). Generate it with the API's own bcrypt so the cost matches:

```bash
cd apps/api
node -e "console.log(require('bcryptjs').hashSync('TheirPassword', 12))"
```

```sql
BEGIN;
INSERT INTO core_users (email, password_hash, full_name, full_name_ar, job_title, department_id, timezone)
SELECT 'new.person@worood.co', '<paste the digest>', 'New Person', 'اسم بالعربية', 'Merchandiser',
       (SELECT id FROM core_departments WHERE name = 'Commercial' LIMIT 1), 'Africa/Cairo';

INSERT INTO core_user_roles (user_id, role_id)
SELECT u.id, r.id FROM core_users u, core_roles r
 WHERE u.email = 'new.person@worood.co' AND r.key = 'employee';
COMMIT;
```

### Suspend or restore someone

`status` is what the login path and `loadPrincipal` check, so this takes effect on
their next request — an open session stops working, it does not wait for the
token to expire.

```sql
UPDATE core_users SET status = 'SUSPENDED' WHERE email = 'someone@worood.co';
UPDATE core_users SET status = 'ACTIVE'    WHERE email = 'someone@worood.co';
```

Prefer `SUSPENDED` to `deleted_at` for someone who has left: a soft-deleted user
still owns their bookings and audit history, and you want those to keep resolving
to a name.

### Change what a role can do

```sql
-- Give sales managers the ability to administer rooms.
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core_roles r, core_permissions p
 WHERE r.key = 'sales-manager' AND p.key = 'meeting-rooms.room.manage'
ON CONFLICT DO NOTHING;

-- Take it away again.
DELETE FROM core_role_permissions
 WHERE role_id = (SELECT id FROM core_roles WHERE key = 'sales-manager')
   AND permission_id = (SELECT id FROM core_permissions WHERE key = 'meeting-rooms.room.manage');
```

`SELECT key, module_key, description FROM core_permissions ORDER BY module_key, key;`
lists everything available. Modules register their own permission rows from their
descriptor, so the list grows as modules are added.

### Create a role

```sql
INSERT INTO core_roles (key, name, name_ar) VALUES ('facilities-lead', 'Facilities Lead', 'مدير المرافق');
-- then grant it permissions with the INSERT above, and assign it to people.
```

### Dashboard access, without the UI

```sql
-- A role gets a dashboard.
INSERT INTO sd_role_dashboard_access (role_id, dashboard_id)
SELECT r.id, d.id FROM core_roles r, sd_dashboards d
 WHERE r.key = 'ops-engineer' AND d.key = 'sales-operations'
ON CONFLICT DO NOTHING;

-- One person, in addition to (or in spite of) their role.
INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
SELECT u.id, d.id, 'GRANT', (SELECT id FROM core_users WHERE email = 'admin@worood.co')
  FROM core_users u, sd_dashboards d
 WHERE u.email = 'hala.mansour@worood.co' AND d.key = 'sales-operations'
ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = EXCLUDED.effect;
```

Change `'GRANT'` to `'REVOKE'` to take one away from a person who would otherwise
get it through their role. **A REVOKE beats a role grant** — that is the whole
reason both tables exist.

Note that the `granted_by` column is why the UI is better than SQL for this: the
composer records who made the change and writes an audit row. SQL does neither
unless you remember to.

## What is missing, and what it would take

There is no admin console: no way to add a person, change a role, or edit a
role's permissions without a database client. For a portal whose entire premise
is that the screen is composed from what each person is granted, that is the
obvious gap.

Building it is roughly:

- **API** — a `core-admin` module: users (list, create, update, suspend, reset
  password), roles (CRUD plus permission assignment), and the user↔role join.
  Gated behind a new `core.user.manage` / `core.role.manage` permission, audited
  the way dashboard access already is.
- **Portal** — a People screen (directory, filters, one person's roles and their
  effective permissions) and a Roles screen (what the role carries, who holds it,
  and what it unlocks in plain language).
- **Care needed in two places.** An admin must not be able to remove their own
  last administering role — the system would become unadministrable, and the
  check belongs on the server. And "effective permissions" should be shown as a
  computed answer, since with roles plus per-user dashboard overrides, nobody
  can hold the whole picture in their head.
