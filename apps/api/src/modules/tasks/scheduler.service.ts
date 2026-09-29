/**
 * The two things that happen to a ticket without anybody doing them.
 *
 * Lateness is a CONDITION, not a status. A ticket can be IN_PROGRESS and
 * OVERDUE at once, and that pair is the useful fact -- it says both where the
 * work is and that it is late. Collapsing the two into one column, so that
 * "delayed" replaces "in progress", throws away half of it and leaves nobody
 * able to say whether anyone is actually working on the thing.
 *
 * The clock keeps running while a ticket is BLOCKED. The person who raised it
 * is waiting either way, so the ticket is late either way; what changes is the
 * explanation, and the screen shows that the delay is a dependency rather than
 * neglect. Suppressing lateness while blocked would make "waiting on another
 * department" a free pass, which is the opposite of what anyone wants.
 *
 * In-process on an interval, matching SalesScheduler rather than inventing a
 * second mechanism. It is idempotent -- it recomputes state from due_at rather
 * than stepping through it -- so a missed cycle, a restart or two processes
 * briefly overlapping all produce the same answer.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { query } from '../../common/db';
import { NotificationsService } from '../../core/core.module';

const MODULE_KEY = 'tasks';
const SWEEP_INTERVAL_MS = 15 * 60_000;
/** How long a ticket may sit in a queue before the manager above is told. */
const UNASSIGNED_ESCALATION_HOURS = 24;

@Injectable()
export class TasksScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TasksScheduler.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly notifications: NotificationsService) {}

  onModuleInit() {
    this.every(SWEEP_INTERVAL_MS, 'sla sweep', () => this.sweep());
    this.every(60 * 60_000, 'unassigned escalation', () => this.escalateUnassigned());
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private every(ms: number, name: string, run: () => Promise<unknown>) {
    const tick = () => run().catch((e) => this.log.warn(`${name} failed: ${(e as Error).message}`));
    // Staggered rather than all at boot, so a restart does not fire everything
    // at once against a database that is still warming up.
    this.timers.push(setInterval(tick, ms));
    setTimeout(tick, 5_000 + this.timers.length * 2_000).unref?.();
  }

  /** Recompute ON_TIME / DUE_SOON / OVERDUE from due_at, and announce crossings. */
  async sweep(): Promise<{ overdue: number; dueSoon: number }> {
    const crossed = await query<{ id: string; reference: string; assignee_id: string | null; state: string }>(
      `UPDATE tk_items t
          SET sla_state = s.next,
              overdue_since = CASE WHEN s.next = 'OVERDUE'
                                   THEN COALESCE(t.overdue_since, now()) ELSE NULL END
         FROM (
           SELECT i.id,
                  CASE WHEN i.due_at < now()                          THEN 'OVERDUE'
                       WHEN i.due_at < now() + interval '24 hours'    THEN 'DUE_SOON'
                       ELSE 'ON_TIME' END AS next
             FROM tk_items i
            WHERE i.due_at IS NOT NULL
              AND i.status IN ('ASSIGNED','IN_PROGRESS','BLOCKED')
         ) AS s
        WHERE t.id = s.id AND t.sla_state IS DISTINCT FROM s.next
        RETURNING t.id, t.reference, t.assignee_id, t.sla_state AS state`);

    for (const row of crossed) {
      if (row.state === 'ON_TIME') continue;
      await query(
        `INSERT INTO tk_events (item_id, actor_id, type, payload) VALUES ($1,NULL,$2,'{}'::jsonb)`,
        [row.id, row.state]);
      if (!row.assignee_id) continue;
      try {
        await this.notifications.notify(
          row.assignee_id, MODULE_KEY,
          row.state === 'OVERDUE' ? `Past its date: ${row.reference}` : `Due tomorrow: ${row.reference}`,
          row.state === 'OVERDUE'
            ? 'The date you committed to has passed. Move it, or say where it stands.'
            : 'The date you committed to is within a day.',
          row.state === 'OVERDUE' ? 'WARNING' : 'INFO',
          `/tasks/${row.id}`);
      } catch (e) {
        this.log.warn(`sla notification failed: ${(e as Error).message}`);
      }
    }

    const overdue = crossed.filter((r) => r.state === 'OVERDUE').length;
    const dueSoon = crossed.filter((r) => r.state === 'DUE_SOON').length;
    if (crossed.length > 0) this.log.log(`sla sweep: ${overdue} overdue, ${dueSoon} due soon`);
    return { overdue, dueSoon };
  }

  /**
   * A ticket nobody has picked up is the one failure the requester cannot see
   * and cannot chase, because as far as they know it is simply "with Customer
   * Care". This is the only routine reason a manager further up the tree hears
   * about a ticket at all -- they see everything below them, but being told
   * about everything below them would bury them in a week.
   */
  async escalateUnassigned(): Promise<number> {
    const stale = await query<any>(
      `SELECT t.id, t.reference, t.title, d.name AS department, d.parent_id
         FROM tk_items t JOIN core_departments d ON d.id = t.department_id
        WHERE t.status = 'NEW'
          AND t.created_at < now() - ($1 || ' hours')::interval
          AND NOT EXISTS (SELECT 1 FROM tk_events e
                           WHERE e.item_id = t.id AND e.type = 'ESCALATED')`,
      [String(UNASSIGNED_ESCALATION_HOURS)]);

    for (const row of stale) {
      const above = row.parent_id
        ? await query<{ user_id: string }>(
            `SELECT m.user_id FROM core_department_managers m
               JOIN core_users u ON u.id = m.user_id
              WHERE m.department_id = $1 AND u.deleted_at IS NULL AND u.status='ACTIVE'`,
            [row.parent_id])
        : [];
      const own = await query<{ user_id: string }>(
        `SELECT m.user_id FROM core_department_managers m
           JOIN core_users u ON u.id = m.user_id
          WHERE m.department_id = (SELECT department_id FROM tk_items WHERE id=$1)
            AND u.deleted_at IS NULL AND u.status='ACTIVE'`, [row.id]);

      for (const m of [...own, ...above]) {
        try {
          await this.notifications.notify(
            m.user_id, MODULE_KEY, `Still unassigned after a day: ${row.reference}`,
            `"${row.title}" has been waiting in ${row.department} with nobody on it.`,
            'WARNING', `/tasks/${row.id}`);
        } catch (e) {
          this.log.warn(`escalation notification failed: ${(e as Error).message}`);
        }
      }
      await query(
        `INSERT INTO tk_events (item_id, actor_id, type, payload) VALUES ($1,NULL,'ESCALATED',$2)`,
        [row.id, JSON.stringify({ hours: UNASSIGNED_ESCALATION_HOURS })]);
    }
    if (stale.length > 0) this.log.log(`escalated ${stale.length} unassigned ticket(s)`);
    return stale.length;
  }
}
