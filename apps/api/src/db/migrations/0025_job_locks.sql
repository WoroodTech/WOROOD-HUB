-- 0025_job_locks.sql
-- One lease per exclusive job, so two application instances cannot run it at
-- once.
--
-- The scheduler guards its jobs with a `running` boolean held in the process.
-- That is enough for one process and nothing more: the moment a second
-- instance exists -- a second EC2 node, the worker alongside the API, a deploy
-- where the old and new processes overlap for a few seconds -- both hold their
-- own flag, both see false, and both run. For reconciliation that is double the
-- Shopify quota and two passes interleaving on one cursor. For the nightly
-- capture it is two bulk exports where Shopify permits one. For the escalation
-- sweep it is two notifications to the same manager about the same ticket.
--
-- The lease is the same shape as the webhook worker's, for the same reason: a
-- lock that cannot expire turns one crashed process into a job that never runs
-- again, which is worse than the duplicate it was meant to prevent.
--
-- last_ok_at doubles as the once-a-day record. The nightly jobs used a
-- process-local date string, so a restart at 02:30 ran them a second time and
-- a second instance ran them regardless; asking the table instead makes
-- "already done today" a fact about the system rather than about one process.

CREATE TABLE IF NOT EXISTS core_job_locks (
  name         text PRIMARY KEY,
  owner        text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_run_at  timestamptz,
  last_ok_at   timestamptz,
  last_error   text
);

COMMENT ON TABLE core_job_locks IS
  'Leases for scheduled jobs that must not run on two instances at once. A row per job name; the lease expires so a crash cannot hold it for ever.';
COMMENT ON COLUMN core_job_locks.owner IS
  'Which instance holds it. Diagnostic and ownership-checked on release, not the basis of exclusion — that is the conditional acquire.';
COMMENT ON COLUMN core_job_locks.expires_at IS
  'When the lease lapses and another instance may take it, however the holder ended.';
COMMENT ON COLUMN core_job_locks.last_ok_at IS
  'When the job last completed. Read by once-a-day jobs so a restart does not repeat them.';