/**
 * Running a job on one instance at a time.
 *
 * The scheduler's `running` flag is per-process, which is exactly as much
 * protection as there are processes. Two API instances, or the API and the
 * worker, each hold their own and each sees it false.
 *
 * So exclusivity is decided where both can see it. The acquire is a single
 * conditional statement -- no read, no check, no second write -- and the lease
 * expires, because a lock that cannot expire turns one crashed process into a
 * job that never runs again.
 *
 * Only for jobs that are genuinely exclusive. Most are not: a job whose writes
 * are idempotent is better left to run twice occasionally than wrapped in
 * machinery that can fail in its own ways.
 */
import { randomUUID } from 'node:crypto';
import { query, one } from './db';

/** Identifies this process in `owner`. Stable for the life of the process. */
export const INSTANCE_ID =
  process.env.INSTANCE_ID || `${process.env.HOSTNAME || 'api'}-${process.pid}-${randomUUID().slice(0, 8)}`;

export type JobOutcome = 'ran' | 'held-elsewhere' | 'already-done-today';

export interface JobLockOptions {
  /** How long the lease is held before another instance may take it. Should
   *  comfortably exceed the job's normal duration. */
  ttlMs?: number;
  /** Renew every ttl/3 while the job runs, for jobs that can outlast the ttl. */
  renew?: boolean;
  owner?: string;
}

/**
 * Take the lease if it is free or expired.
 *
 * `WHERE core_job_locks.expires_at <= now()` on the conflicting update is what
 * makes this safe: the row is locked while the condition is evaluated, so of
 * two instances arriving together exactly one writes and the other gets
 * nothing back. Nothing is read first, so there is no window between deciding
 * and acting.
 */
export async function acquire(
  name: string, ttlMs: number, owner = INSTANCE_ID,
): Promise<boolean> {
  const rows = await query<{ name: string }>(
    `INSERT INTO core_job_locks (name, owner, acquired_at, expires_at, last_run_at)
     VALUES ($1, $2, now(), now() + ($3 || ' milliseconds')::interval, now())
     ON CONFLICT (name) DO UPDATE
       SET owner = $2, acquired_at = now(),
           expires_at = now() + ($3 || ' milliseconds')::interval,
           last_run_at = now()
     WHERE core_job_locks.expires_at <= now()
     RETURNING name`,
    [name, owner, String(ttlMs)]);
  return rows.length > 0;
}

/**
 * Give the lease back, recording how the job ended.
 *
 * Conditional on still owning it. A job that overran its lease has already had
 * it taken by somebody else, and writing `last_ok_at` then would credit this
 * instance's outcome to a run that is still going.
 */
export async function release(
  name: string, ok: boolean, error?: string, owner = INSTANCE_ID,
): Promise<boolean> {
  const rows = await query<{ name: string }>(
    `UPDATE core_job_locks
        SET expires_at = now(),
            last_ok_at = CASE WHEN $3 THEN now() ELSE last_ok_at END,
            last_error = CASE WHEN $3 THEN NULL ELSE $4 END
      WHERE name = $1 AND owner = $2
      RETURNING name`,
    [name, owner, ok, error?.slice(0, 500) ?? null]);
  return rows.length > 0;
}

/** Extend a lease while the job is still running. Conditional on ownership. */
export async function renew(name: string, ttlMs: number, owner = INSTANCE_ID): Promise<boolean> {
  const rows = await query<{ name: string }>(
    `UPDATE core_job_locks
        SET expires_at = now() + ($3 || ' milliseconds')::interval
      WHERE name = $1 AND owner = $2 AND expires_at > now()
      RETURNING name`,
    [name, owner, String(ttlMs)]);
  return rows.length > 0;
}

/**
 * Run `fn` only if this instance can take the lease.
 *
 * Returns what happened rather than throwing when the lock is held: another
 * instance running the job is the system working, not an error, and it should
 * not appear in the log as one.
 */
export async function withJobLock<T>(
  name: string, fn: () => Promise<T>, opts: JobLockOptions = {},
): Promise<{ outcome: JobOutcome; value?: T }> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const owner = opts.owner ?? INSTANCE_ID;

  if (!await acquire(name, ttlMs, owner)) return { outcome: 'held-elsewhere' };

  let timer: NodeJS.Timeout | null = null;
  if (opts.renew) {
    timer = setInterval(() => { void renew(name, ttlMs, owner).catch(() => undefined); }, ttlMs / 3);
    timer.unref?.();
  }

  try {
    const value = await fn();
    await release(name, true, undefined, owner);
    return { outcome: 'ran', value };
  } catch (e: any) {
    /* Released on failure too, and deliberately. Holding a lease until it
       expires because the job threw would delay the retry by the whole ttl for
       no benefit: the next run is the retry, and whether it should happen is
       the schedule's business, not the lock's. */
    await release(name, false, String(e?.message ?? e), owner);
    throw e;
  } finally {
    if (timer) clearInterval(timer);
  }
}

/**
 * Run `fn` at most once per calendar day, across every instance.
 *
 * The nightly jobs kept the date in a process field, so a restart at half past
 * two ran them again and a second instance ran them regardless of what the
 * first had done. The date comes from the caller rather than from here because
 * "today" is Africa/Cairo for this system, not UTC and not the server's idea
 * of local time.
 */
export async function runDailyOnce<T>(
  name: string, today: string, fn: () => Promise<T>, opts: JobLockOptions = {},
): Promise<{ outcome: JobOutcome; value?: T }> {
  /* Checked before taking the lease: if it already ran today there is nothing
     to coordinate, and taking a lease to discover that would make every
     instance queue behind whichever one got there first. */
  if (await ranOn(name, today)) return { outcome: 'already-done-today' };

  return withJobLock(name, async () => {
    /* And again inside the lease. Two instances can both pass the check above
       at the same instant; only one takes the lock, and the other arrives here
       after the first has finished and written last_ok_at. Without this second
       look it would run the job a second time having waited for the first. */
    if (await ranOn(name, today)) return undefined as T;
    return fn();
  }, opts);
}

/** Did this job last complete on the given day? */
export async function ranOn(name: string, today: string): Promise<boolean> {
  const row = await one<{ last_ok_at: Date | null }>(
    `SELECT last_ok_at FROM core_job_locks WHERE name = $1`, [name]);
  if (!row?.last_ok_at) return false;
  return dayOf(row.last_ok_at) === today;
}

/** The Africa/Cairo calendar day of an instant, as YYYY-MM-DD. */
export function dayOf(at: Date | string, timeZone = 'Africa/Cairo'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
}

/** What the locks look like now. Read by the health screen in Phase 8. */
export async function lockStatus(): Promise<any[]> {
  return query(
    `SELECT name, owner, acquired_at, expires_at, last_run_at, last_ok_at, last_error,
            (expires_at > now()) AS held
       FROM core_job_locks ORDER BY name`);
}