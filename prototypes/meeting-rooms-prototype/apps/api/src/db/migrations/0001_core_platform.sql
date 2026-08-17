-- ===========================================================================
-- WOROOD HUB — Migration 0001: core platform
-- ---------------------------------------------------------------------------
-- Tables prefixed core_* belong to the platform and are shared by every
-- module. Feature modules own their own prefix and never alter these tables.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist";   -- required by the overlap guard
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive e-mail

-- --------------------------------------------------------------------------
-- Enumerations
-- --------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without trusting the application
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- Departments (self-referencing tree)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(32)  NOT NULL UNIQUE,
  name        varchar(160) NOT NULL,
  name_ar     varchar(160),
  parent_id   uuid REFERENCES core_departments(id) ON DELETE SET NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_departments_parent_idx ON core_departments (parent_id);

-- --------------------------------------------------------------------------
-- Users
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no           varchar(32)  NOT NULL UNIQUE,
  email                 citext       NOT NULL UNIQUE,
  password_hash         varchar(255) NOT NULL,
  full_name             varchar(160) NOT NULL,
  full_name_ar          varchar(160),
  job_title             varchar(120),
  phone                 varchar(32),
  avatar_url            varchar(255),
  department_id         uuid REFERENCES core_departments(id) ON DELETE SET NULL,
  status                user_status  NOT NULL DEFAULT 'ACTIVE',
  locale                varchar(8)   NOT NULL DEFAULT 'en',
  timezone              varchar(64)  NOT NULL DEFAULT 'Africa/Cairo',
  must_change_password  boolean      NOT NULL DEFAULT false,
  failed_login_count    integer      NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE INDEX IF NOT EXISTS core_users_department_idx ON core_users (department_id);
CREATE INDEX IF NOT EXISTS core_users_status_idx     ON core_users (status) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS core_users_updated_at ON core_users;
CREATE TRIGGER core_users_updated_at BEFORE UPDATE ON core_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- RBAC: roles, permissions and their join tables
-- Permission keys are namespaced by module: "<module>.<entity>.<action>"
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         varchar(64)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  description varchar(255),
  is_system   boolean      NOT NULL DEFAULT false,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         varchar(96)  NOT NULL UNIQUE,
  module_key  varchar(64)  NOT NULL,
  description varchar(255),
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_permissions_module_idx ON core_permissions (module_key);

CREATE TABLE IF NOT EXISTS core_role_permissions (
  role_id       uuid NOT NULL REFERENCES core_roles(id)       ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES core_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS core_user_roles (
  user_id     uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES core_roles(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- --------------------------------------------------------------------------
-- Refresh tokens — stored hashed so a DB leak cannot be replayed
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  token_hash  varchar(255) NOT NULL UNIQUE,
  user_agent  varchar(255),
  ip_address  varchar(64),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_refresh_tokens_user_idx    ON core_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS core_refresh_tokens_expires_idx ON core_refresh_tokens (expires_at);

-- --------------------------------------------------------------------------
-- Audit log — append only, every module writes here
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES core_users(id) ON DELETE SET NULL,
  module_key    varchar(64) NOT NULL,
  action        varchar(96) NOT NULL,
  entity_type   varchar(64),
  entity_id     varchar(64),
  metadata      jsonb,
  ip_address    varchar(64),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_audit_logs_actor_idx  ON core_audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS core_audit_logs_module_idx ON core_audit_logs (module_key, created_at DESC);
CREATE INDEX IF NOT EXISTS core_audit_logs_entity_idx ON core_audit_logs (entity_type, entity_id);

-- --------------------------------------------------------------------------
-- In-app notifications
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
  module_key varchar(64)  NOT NULL,
  type       varchar(64)  NOT NULL,
  title      varchar(190) NOT NULL,
  body       varchar(1000),
  link       varchar(255),
  read_at    timestamptz,
  created_at timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_notifications_user_idx ON core_notifications (user_id, read_at);

-- --------------------------------------------------------------------------
-- Runtime settings — module-scoped, so a module ships settings with no DDL
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_settings (
  key        varchar(128) PRIMARY KEY,
  module_key varchar(64) NOT NULL,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_settings_module_idx ON core_settings (module_key);
