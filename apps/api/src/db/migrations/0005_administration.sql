-- 0005_administration.sql
-- The administration console: people, roles and dashboard assignment.
--
-- No new tables. Everything it manages already exists -- core_users,
-- core_roles, core_permissions and their joins have been there since 0001, and
-- dashboard access since 0003. What was missing was a way to reach them that
-- was not a database client, and two permission keys to gate it with.
--
-- Written as a migration rather than left to the seeder because an install that
-- is already running must gain the console without `--reset` wiping its data.

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('core.user.manage', 'core',
   'Create employee accounts, change their details and password, assign roles and dashboards'),
  ('core.role.manage', 'core',
   'Create roles and decide which permissions each one carries'),
  ('core.audit.view',  'core',
   'Read the audit trail')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description,
                                module_key  = EXCLUDED.module_key;

-- The administrator role gets them. This is the only place a permission is
-- handed out by migration rather than by an administrator, and it exists for a
-- single reason: without it there is nobody who can open the console to grant
-- it, and the system is unadministrable from a cold start.
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r, core_permissions p
 WHERE r.key = 'admin'
   AND p.key IN ('core.user.manage', 'core.role.manage', 'core.audit.view')
ON CONFLICT DO NOTHING;

-- Changing an e-mail address or a password has to be able to end that person's
-- other sessions, so the console needs to delete their refresh tokens by user.
-- The unique index on token_hash does not serve that lookup.
CREATE INDEX IF NOT EXISTS core_refresh_tokens_user_idx ON core_refresh_tokens (user_id);

-- The console reads "who holds this role" and "who has this permission" on
-- every screen; both walk these joins from the role side, which the primary
-- keys (user_id, role_id) and (role_id, permission_id) do not serve.
CREATE INDEX IF NOT EXISTS core_user_roles_role_idx ON core_user_roles (role_id);
CREATE INDEX IF NOT EXISTS core_role_permissions_permission_idx ON core_role_permissions (permission_id);
