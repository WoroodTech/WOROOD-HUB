# Administration: people, roles and dashboard access

August 2026. **Status: built.** People, roles and dashboard assignment all have
screens, behind `core.user.manage` / `core.role.manage`, which only the
`admin` role carries. The SQL below still works and is kept as the escape hatch
for the one case the console deliberately cannot serve: an install with no
administrator left.

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

| Question | Where it lives | Screen |
|---|---|---|
| Does this person exist, and are they active? | `core_users` | **Administration → People** |
| Which roles does this person hold? | `core_user_roles` | **Administration → People** |
| Which dashboards does this *person* get? | `sd_user_dashboard_access` | **Administration → People** |
| Which permissions does this role carry? | `core_role_permissions` | **Administration → Roles** |
| Which dashboards does a *role* get? | `sd_role_dashboard_access` | **Sales → Manage Dashboards** |

## The console

**Administration → People.** A directory on the left, one person on the right.
From here: create an account, change a name, e-mail address, job title,
department or status, set a password, hold and remove roles, and assign or
block individual dashboards. It also shows *effective permissions* — everything
their roles add up to, each one labelled with the role that supplied it,
because "why can they do that?" is the question the screen exists to answer.

**Administration → Roles.** What each role carries, grouped by the module that
registered the permission, with the holder count on every row. That count is on
screen before you touch a checkbox on purpose: one tick here changes what
everyone holding the role can reach.

Both are gated on `core.user.manage` / `core.role.manage`, which only `admin`
holds. The navigation is permission-filtered like every other module's, and the
API refuses the routes independently — hiding a link is a courtesy, the guard
is the rule.

**Role → dashboard grants still live in the sales composer** (Sales → Manage
Dashboards → Access), because they belong to the dashboard rather than to a
person. The People screen edits the individual overrides on top of them.

### What the console refuses to do

All checked on the server, so a direct API call hits the same wall:

- You cannot suspend or delete **your own** account.
- You cannot remove your own administrator role while you are the only
  administrator, nor strip `core.user.manage` from the last role that carries
  it. Both refuse with a message naming what to do first. With a second
  administrator in place, the same operations are allowed — the rails count,
  they do not refuse categorically.
- A role held by somebody is not deleted; the message says how many hold it.
- Deleting a person is a **soft** delete. The row survives so their bookings and
  audit history keep resolving to a name.

### Credentials and sessions

Changing an **e-mail address** or a **password** ends that person's other
sessions by deleting their refresh tokens — otherwise the change would be
decorative and the old session would keep working. The password dialog lets you
turn that off for the one case where it is wrong: resetting a forgotten password
for somebody sitting next to you who is staying signed in.

The audit trail records that a password was set, by whom and when. It never
records the password or its digest.

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

Still valid, and still the only way out if the last administrator account is
lost — the console cannot let you back in, by design. Every statement below was
run against a real database before being written here. Wrap them in
`BEGIN; … COMMIT;` and check the `SELECT` first if you are nervous.

Prefer the console for everyday work: it records `granted_by` and writes an
audit row, and SQL does neither unless you remember to.

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

## Tests

```bash
npm run build && node dist/main.js &
npx tsx test/administration.test.ts      # 55 assertions
```

The ones worth knowing about, because they are the failures nobody wants to find
in production, and each is proven by *doing* it rather than by inspecting state:

- A non-administrator is refused every route, read and write.
- Changing an e-mail: the old address stops signing in, the new one works, and
  the refresh token issued before the change is rejected.
- Setting a password: the new one works, the old one does not, and a session
  open at the time cannot be refreshed. The audit payload is checked for the
  absence of both the plaintext and a bcrypt digest.
- An individual REVOKE beats a role grant — and the *sales module* is then asked
  what that person can see, so the console's arithmetic is checked against the
  code that actually serves them rather than against itself.
- Every lockout rail, in both directions: refused while alone, allowed once a
  second administrator exists.

## Still missing

- **The audit trail has no screen.** `core.audit.view` exists and everything
  writes to `core_audit_logs`, but reading it is still SQL.
- **No self-service.** Nobody can change their own password; an administrator
  sets it and tells them. There is no reset-by-e-mail flow, because there is no
  mail transport in this build.
- **Departments** are seeded and selectable but not editable.
- **Bulk actions.** Roles are assigned one person at a time.
