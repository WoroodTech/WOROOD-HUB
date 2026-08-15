-- 0001_core_platform.sql
-- WOROOD HUB core platform: identity, RBAC, audit, notifications, settings.
-- Owns every core_* table. No feature module writes here except through the
-- core's own services -- that single rule is what keeps modules removable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE core_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, name_ar text,
  parent_id uuid REFERENCES core_departments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL, full_name_ar text, job_title text,
  department_id uuid REFERENCES core_departments(id),
  timezone text NOT NULL DEFAULT 'Africa/Cairo',
  locale text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'ACTIVE',
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz, last_login_at timestamptz, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_users_active_idx ON core_users (status) WHERE deleted_at IS NULL;

CREATE TABLE core_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE, name text NOT NULL, name_ar text, description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Permission keys are namespaced by owning module: '<module>.<entity>.<action>'.
CREATE TABLE core_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE, module_key text NOT NULL, description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_permissions_module_idx ON core_permissions (module_key);

CREATE TABLE core_role_permissions (
  role_id uuid NOT NULL REFERENCES core_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES core_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE core_user_roles (
  user_id uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES core_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Stored only as SHA-256 hashes, so a database disclosure cannot be replayed.
-- Single use: presenting one revokes it and issues a new pair.
CREATE TABLE core_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device text, ip inet,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_refresh_tokens_user_idx ON core_refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE core_audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES core_users(id),
  module_key text, action text NOT NULL, entity_type text, entity_id text,
  payload jsonb, ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_audit_logs_actor_idx ON core_audit_logs (actor_id, created_at DESC);
CREATE INDEX core_audit_logs_action_idx ON core_audit_logs (action, created_at DESC);

CREATE TABLE core_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  module_key text NOT NULL, severity text NOT NULL DEFAULT 'INFO',
  title text NOT NULL, body text, link text, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX core_notifications_user_idx ON core_notifications (user_id, created_at DESC);

CREATE TABLE core_settings (
  module_key text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module_key, key)
);

-- The runner bootstraps this itself before applying anything, so IF NOT EXISTS:
-- it documents the table for a reader without fighting the runner.
CREATE TABLE IF NOT EXISTS core_migrations (
  id serial PRIMARY KEY, filename text NOT NULL UNIQUE,
  checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER core_departments_updated BEFORE UPDATE ON core_departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER core_users_updated BEFORE UPDATE ON core_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER core_roles_updated BEFORE UPDATE ON core_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
