/**
 * Departments, and who runs them.
 *
 * This exists because Module 3 made the org chart load-bearing. Authority over
 * a department is a position rather than a role — a role would be company-wide
 * and would let the Marketing manager assign work inside Customer Care — so
 * `core_department_managers` decides who may hand work out, and until this
 * screen there was no way to edit it except SQL.
 *
 * The rail that matters: **a department must keep at least one active
 * manager.** Without one, tickets raised to it can never be assigned by
 * anybody, and the person who raised it cannot tell — as far as they can see it
 * is simply "with Customer Care". The module hides such a department from the
 * target picker for exactly that reason, which means losing the last manager
 * silently takes a department out of service.
 *
 * It is enforced here rather than by a constraint because the check needs to
 * know who is acting and what to tell them to do first, which is the same
 * reason the last-administrator rails live in `guards.ts` rather than in SQL.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Principal } from '../../common/auth';
import { one, query } from '../../common/db';
import { AuditService } from '../../core/core.module';

@Injectable()
export class AdminDepartmentsService {
  constructor(private readonly audit: AuditService) {}

  /** Every department, its managers and its size. */
  async list() {
    const departments = await query(
      `SELECT d.id, d.name, d.name_ar, d.parent_id, p.name AS parent_name,
              (SELECT count(*)::int FROM core_users u
                WHERE u.department_id = d.id AND u.deleted_at IS NULL
                  AND u.status = 'ACTIVE') AS head_count
         FROM core_departments d
         LEFT JOIN core_departments p ON p.id = d.parent_id
        ORDER BY d.name`);

    /* Only ACTIVE managers count. A suspended account cannot sign in, so a
       department whose only manager is suspended is as unreachable as one with
       none — and the screen must say so rather than showing a name. */
    const managers = await query(
      `SELECT m.department_id, u.id, u.full_name, u.job_title, u.email,
              (u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS active
         FROM core_department_managers m
         JOIN core_users u ON u.id = m.user_id
        ORDER BY u.full_name`);

    return {
      departments: departments.map((d) => {
        const mine = managers.filter((m) => m.department_id === d.id);
        return {
          id: d.id, name: d.name, nameAr: d.name_ar,
          parentId: d.parent_id, parentName: d.parent_name,
          headCount: d.head_count,
          managers: mine.map((m) => ({
            id: m.id, name: m.full_name, jobTitle: m.job_title,
            email: m.email, active: m.active,
          })),
          /* The screen leads with this rather than making somebody count. */
          reachable: mine.some((m) => m.active),
        };
      }),
    };
  }

  /** People who could be made a manager here: the department's own members. */
  async candidates(departmentId: string) {
    return query(
      `SELECT u.id, u.full_name AS name, u.job_title,
              EXISTS (SELECT 1 FROM core_department_managers m
                       WHERE m.department_id = $1 AND m.user_id = u.id) AS is_manager
         FROM core_users u
        WHERE u.department_id = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        ORDER BY is_manager DESC, u.full_name`, [departmentId]);
  }

  async addManager(actor: Principal, departmentId: string, userId: string) {
    const department = await one<any>(
      `SELECT id, name FROM core_departments WHERE id = $1`, [departmentId]);
    if (!department) throw new NotFoundException('No such department.');

    const user = await one<any>(
      `SELECT id, full_name, department_id, status, deleted_at
         FROM core_users WHERE id = $1`, [userId]);
    if (!user || user.deleted_at || user.status !== 'ACTIVE') {
      throw new BadRequestException('That person is not an active employee.');
    }
    /* Running a department you are not in is a different thing from running
       one you are, and nothing in the module expects it: the assign screen
       offers only the department's own members, so such a manager could see a
       queue and have nobody to put on it. */
    if (user.department_id !== departmentId) {
      throw new BadRequestException(
        `${user.full_name} is not in ${department.name}. Move them there first, or choose somebody who is.`);
    }

    await query(
      `INSERT INTO core_department_managers (department_id, user_id, assigned_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [departmentId, userId, actor.id]);

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.department.manager_added',
      entityType: 'department', entityId: departmentId,
      payload: { userId, name: user.full_name, department: department.name },
    });
    return this.list();
  }

  async removeManager(actor: Principal, departmentId: string, userId: string) {
    await assertDepartmentKeepsAManager(departmentId, [userId],
      'Removing this manager');

    const { rowCount } = await queryRaw(
      `DELETE FROM core_department_managers WHERE department_id = $1 AND user_id = $2`,
      [departmentId, userId]);
    if (rowCount === 0) throw new NotFoundException('They do not manage this department.');

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.department.manager_removed',
      entityType: 'department', entityId: departmentId, payload: { userId },
    });
    return this.list();
  }
}

/* `query` returns rows; deletes need the count. */
async function queryRaw(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
  const rows = await query(`${sql} RETURNING user_id`, params);
  return { rowCount: rows.length };
}

/**
 * Refuse anything that would leave a department with no active manager.
 *
 * `losing` is who is about to stop counting — the manager being removed, or
 * the person about to be suspended, deleted or moved out of the department.
 * Shared by the departments screen and by the people screen, because a
 * department can be emptied from either and only one of them is obvious.
 */
export async function assertDepartmentKeepsAManager(
  departmentId: string | null, losing: string[], what: string,
): Promise<void> {
  const orphaned = await query<{ name: string }>(
    `SELECT d.name
       FROM core_departments d
      WHERE ($1::uuid IS NULL OR d.id = $1)
        AND EXISTS (SELECT 1 FROM core_department_managers m
                     WHERE m.department_id = d.id AND m.user_id = ANY($2::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM core_department_managers m
            JOIN core_users u ON u.id = m.user_id
           WHERE m.department_id = d.id
             AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
             AND NOT (u.id = ANY($2::uuid[]))
        )`,
    [departmentId, losing]);

  if (orphaned.length === 0) return;
  const names = orphaned.map((d) => d.name).join(' and ');
  throw new ConflictException(
    `${what} would leave ${names} with no manager. Tickets raised to ` +
    `${orphaned.length === 1 ? 'it' : 'them'} could never be assigned, and nobody ` +
    `would be told. Add another manager there first.`,
  );
}
