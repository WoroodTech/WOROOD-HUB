/**
 * People: accounts, their roles, and the dashboards granted to them personally.
 *
 * Three things run through everything here.
 *
 * 1. **Roles are a set, and every write replaces it.** `roleIds: []` removes
 *    every role. An API where sending a field sometimes adds and sometimes
 *    replaces is one where nobody is sure what a save did.
 *
 * 2. **Credentials changing ends other sessions.** Changing an e-mail address
 *    or a password is what you do when an account may be compromised or a
 *    person has left, and leaving their refresh tokens alive would make the
 *    change decorative -- the old session keeps working until its token
 *    expires. The access token still has its short life, which is why the
 *    console says "within a few minutes" rather than "immediately".
 *
 * 3. **Everything is audited.** Who changed what, and to what. `payload` never
 *    carries a password or a digest, only the fact that one was set.
 */

import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { one, query, tx } from '../../common/db';
import { config } from '../../common/config';
import type { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { CORE_PERMISSIONS } from './permissions';
import { assertNotSelf, assertSomebodyIsLeft, rolesGrantUserManage } from './guards';
import { assertDepartmentKeepsAManager } from './departments.service';
import type {
  CreateUser, ListUsersQuery, SetPassword, SetUserDashboards, UpdateUser,
} from './dto';

export interface UserSummary {
  id: string; email: string; fullName: string; fullNameAr: string | null;
  jobTitle: string | null; department: string | null; departmentId: string | null;
  timezone: string; locale: string; status: string;
  lastLoginAt: string | null; createdAt: string;
  roles: Array<{ id: string; key: string; name: string }>;
  /** Whether this account can reach the administration console. */
  isAdministrator: boolean;
  /** Departments this person RUNS -- a different question from the one they
   *  belong to, and the one the People screen now asks alongside roles. */
  managedDepartments: Array<{ id: string; name: string }>;
}

export interface UserDetail extends UserSummary {
  /** Everything their roles add up to, computed rather than left to be
   *  worked out from the role list by hand. */
  permissions: Array<{ key: string; moduleKey: string; description: string | null; viaRoles: string[] }>;
  dashboards: Array<{
    id: string; key: string; name: string;
    /** How they reach it: their role, an individual grant, or not at all. */
    viaRole: boolean; override: 'GRANT' | 'REVOKE' | null; effective: boolean;
  }>;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.full_name_ar, u.job_title, u.timezone,
         u.locale, u.status, u.last_login_at, u.created_at,
         u.department_id, d.name AS department,
         COALESCE(
           (SELECT json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name)
                            ORDER BY r.name)
              FROM core_user_roles ur JOIN core_roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id),
           '[]'::json) AS roles,
         EXISTS (
           SELECT 1 FROM core_user_roles ur
             JOIN core_role_permissions rp ON rp.role_id = ur.role_id
             JOIN core_permissions p       ON p.id = rp.permission_id
            WHERE ur.user_id = u.id AND p.key = 'core.user.manage'
         ) AS is_administrator,
         /* Which departments this person RUNS, which is a different question
            from which one they belong to. Returned here so the People screen
            can ask it in the same place it asks about roles -- an org chart
            edited on a screen nobody opens while adding an employee is an org
            chart that goes stale. */
         COALESCE(
           (SELECT json_agg(json_build_object('id', md.id, 'name', md.name) ORDER BY md.name)
              FROM core_department_managers m
              JOIN core_departments md ON md.id = m.department_id
             WHERE m.user_id = u.id),
           '[]'::json) AS managed_departments
    FROM core_users u
    LEFT JOIN core_departments d ON d.id = u.department_id
   WHERE u.deleted_at IS NULL`;

const toSummary = (r: any): UserSummary => ({
  id: r.id, email: r.email, fullName: r.full_name, fullNameAr: r.full_name_ar,
  jobTitle: r.job_title, department: r.department, departmentId: r.department_id,
  timezone: r.timezone, locale: r.locale, status: r.status,
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
  roles: r.roles ?? [],
  isAdministrator: !!r.is_administrator,
  managedDepartments: r.managed_departments ?? [],
});

@Injectable()
export class AdminUsersService {
  constructor(private readonly audit: AuditService) {}

  /* --------------------------------------------------------------- reads -- */

  async list(q: ListUsersQuery): Promise<{ users: UserSummary[] }> {
    const where: string[] = [];
    const params: any[] = [];

    if (!q.status || q.status === 'ACTIVE') where.push(`u.status = 'ACTIVE'`);
    else if (q.status !== 'ALL') { params.push(q.status); where.push(`u.status = $${params.length}`); }

    if (q.departmentId) { params.push(q.departmentId); where.push(`u.department_id = $${params.length}`); }
    if (q.roleId) {
      params.push(q.roleId);
      where.push(`EXISTS (SELECT 1 FROM core_user_roles ur
                           WHERE ur.user_id = u.id AND ur.role_id = $${params.length})`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(u.full_name ILIKE $${params.length} OR u.full_name_ar ILIKE $${params.length}
                   OR u.email ILIKE $${params.length} OR u.job_title ILIKE $${params.length})`);
    }

    const rows = await query(
      `${USER_SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY u.full_name`,
      params);
    return { users: rows.map(toSummary) };
  }

  async get(id: string): Promise<UserDetail> {
    const row = await one(`${USER_SELECT} AND u.id = $1`, [id]);
    if (!row) throw new NotFoundException('No such employee');

    /* Effective permissions, with the role that supplied each one -- "why can
       they do that?" is the question this screen exists to answer, and a flat
       list of keys does not answer it. */
    const permissions = await query(
      `SELECT p.key, p.module_key, p.description,
              ARRAY_AGG(DISTINCT r.name ORDER BY r.name) AS via_roles
         FROM core_user_roles ur
         JOIN core_roles r             ON r.id = ur.role_id
         JOIN core_role_permissions rp ON rp.role_id = r.id
         JOIN core_permissions p       ON p.id = rp.permission_id
        WHERE ur.user_id = $1
        GROUP BY p.key, p.module_key, p.description
        ORDER BY p.module_key, p.key`, [id]);

    const dashboards = await this.dashboardsFor(id);

    return {
      ...toSummary(row),
      permissions: permissions.map((p) => ({
        key: p.key, moduleKey: p.module_key, description: p.description, viaRoles: p.via_roles ?? [],
      })),
      dashboards,
    };
  }

  /**
   * Every dashboard, and how this person reaches it -- role, individual
   * override, or not at all. Returning all of them rather than only the
   * granted ones is deliberate: assigning is done from this list, and you
   * cannot grant what the screen does not show you.
   */
  private async dashboardsFor(userId: string): Promise<UserDetail['dashboards']> {
    const rows = await query(
      `SELECT d.id, d.key, d.name,
              EXISTS (SELECT 1 FROM sd_role_dashboard_access a
                        JOIN core_user_roles ur ON ur.role_id = a.role_id
                       WHERE a.dashboard_id = d.id AND ur.user_id = $1) AS via_role,
              (SELECT ua.effect FROM sd_user_dashboard_access ua
                WHERE ua.dashboard_id = d.id AND ua.user_id = $1) AS override
         FROM sd_dashboards d
        WHERE d.deleted_at IS NULL
        ORDER BY d.name`, [userId]);

    return rows.map((d) => ({
      id: d.id, key: d.key, name: d.name,
      viaRole: !!d.via_role,
      override: d.override ?? null,
      // A REVOKE always beats a role grant. This mirrors AccessService.resolve;
      // if that rule ever changes, both must change together.
      effective: d.override === 'REVOKE' ? false : (d.override === 'GRANT' || !!d.via_role),
    }));
  }

  /* -------------------------------------------------------------- writes -- */

  async create(actor: Principal, dto: CreateUser): Promise<UserDetail> {
    const digest = await bcrypt.hash(dto.password, config.security.bcryptRounds);
    const roleIds = dto.roleIds ?? [];
    await this.assertRolesExist(roleIds);

    const id = await tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO core_users (email, password_hash, full_name, full_name_ar, job_title,
             department_id, timezone, locale)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'Africa/Cairo'),COALESCE($8,'en'))
           RETURNING id`,
          [dto.email.trim(), digest, dto.fullName.trim(), dto.fullNameAr ?? null,
           dto.jobTitle ?? null, dto.departmentId ?? null, dto.timezone ?? null, dto.locale ?? null],
        )).rows[0];
      } catch (e: any) {
        if (e.code === '23505') throw new ConflictException(`${dto.email} already has an account`);
        if (e.code === '23503') throw new BadRequestException('That department does not exist');
        throw e;
      }
      for (const roleId of roleIds) {
        await c.query(`INSERT INTO core_user_roles (user_id, role_id) VALUES ($1,$2)
                       ON CONFLICT DO NOTHING`, [row.id, roleId]);
      }
      return row.id as string;
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.user.created',
      entityType: 'user', entityId: id,
      payload: { email: dto.email, fullName: dto.fullName, roleIds },
    });
    return this.get(id);
  }

  async update(actor: Principal, id: string, dto: UpdateUser): Promise<UserDetail> {
    const before = await this.get(id);

    /* Anything that could remove the last way into the console is checked
       before a single column is written. */
    if (dto.status === 'SUSPENDED') {
      assertNotSelf(actor.id, id, 'suspend');
      await assertSomebodyIsLeft(id, false, 'Suspending this account');
      /* A suspended account cannot sign in, so a department whose only manager
         is suspended is as unreachable as one with none -- and nothing would
         say so until somebody raised a ticket into it and waited. */
      await assertDepartmentKeepsAManager(null, [id], 'Suspending this account');
    }
    if (dto.departmentId !== undefined && dto.departmentId !== before.departmentId) {
      /* Moving somebody out of a department they run leaves them managing a
         team they are no longer part of, and the assign picker only offers a
         department's own members -- so they would see a queue with nobody to
         put on it. */
      await assertDepartmentKeepsAManager(before.departmentId ?? null, [id],
        'Moving this person to another department');
    }
    if (dto.roleIds !== undefined) {
      await this.assertRolesExist(dto.roleIds);
      const keepsConsole = await rolesGrantUserManage(dto.roleIds);
      if (before.isAdministrator && !keepsConsole) {
        await assertSomebodyIsLeft(id, false, 'Removing the administrator role from this account');
      }
    }

    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, value: any) => {
      if (value === undefined) return;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    set('email', dto.email?.trim());
    set('full_name', dto.fullName?.trim());
    set('full_name_ar', dto.fullNameAr);
    set('job_title', dto.jobTitle);
    set('department_id', dto.departmentId);
    set('timezone', dto.timezone);
    set('locale', dto.locale);
    set('status', dto.status);

    const emailChanged = !!dto.email && dto.email.trim().toLowerCase() !== before.email.toLowerCase();

    await tx(async (c) => {
      if (sets.length) {
        params.push(id);
        try {
          await c.query(`UPDATE core_users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        } catch (e: any) {
          if (e.code === '23505') throw new ConflictException(`${dto.email} already has an account`);
          if (e.code === '23503') throw new BadRequestException('That department does not exist');
          throw e;
        }
      }
      if (dto.roleIds !== undefined) {
        await c.query(`DELETE FROM core_user_roles WHERE user_id = $1`, [id]);
        for (const roleId of dto.roleIds) {
          await c.query(`INSERT INTO core_user_roles (user_id, role_id) VALUES ($1,$2)
                         ON CONFLICT DO NOTHING`, [id, roleId]);
        }
      }
      // A suspended account keeps no way back in, and a changed address is a
      // changed identity.
      if (dto.status === 'SUSPENDED' || emailChanged) {
        await c.query(`DELETE FROM core_refresh_tokens WHERE user_id = $1`, [id]);
      }
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.user.updated',
      entityType: 'user', entityId: id,
      payload: {
        changed: Object.keys(dto),
        emailFrom: emailChanged ? before.email : undefined,
        emailTo: emailChanged ? dto.email : undefined,
        rolesFrom: dto.roleIds !== undefined ? before.roles.map((r) => r.key) : undefined,
        sessionsEnded: dto.status === 'SUSPENDED' || emailChanged,
      },
    });
    return this.get(id);
  }

  async setPassword(actor: Principal, id: string, dto: SetPassword): Promise<{ ok: true; sessionsEnded: boolean }> {
    const user = await one(`SELECT id, email FROM core_users WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!user) throw new NotFoundException('No such employee');

    const digest = await bcrypt.hash(dto.password, config.security.bcryptRounds);
    const endOthers = dto.endOtherSessions !== false;

    await tx(async (c) => {
      await c.query(
        `UPDATE core_users SET password_hash = $1, failed_login_count = 0, locked_until = NULL
          WHERE id = $2`, [digest, id]);
      if (endOthers) await c.query(`DELETE FROM core_refresh_tokens WHERE user_id = $1`, [id]);
    });

    // The digest is never written to the audit trail. That a password was set,
    // by whom, and when, is the whole of what the trail needs.
    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.user.password_set',
      entityType: 'user', entityId: id, payload: { sessionsEnded: endOthers },
    });
    return { ok: true, sessionsEnded: endOthers };
  }

  /**
   * The individual GRANT/REVOKE overrides for one person, replaced wholesale.
   * Role-derived access is not touched here -- that belongs on the role, and
   * quietly editing it from a person's page is how two administrators end up
   * disagreeing about why someone can see something.
   */
  async setDashboards(actor: Principal, id: string, dto: SetUserDashboards): Promise<UserDetail> {
    const user = await one(`SELECT id FROM core_users WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!user) throw new NotFoundException('No such employee');

    const ids = dto.assignments.map((a) => a.dashboardId);
    if (ids.length) {
      const found = await query(
        `SELECT id FROM sd_dashboards WHERE id = ANY($1) AND deleted_at IS NULL`, [ids]);
      if (found.length !== new Set(ids).size) {
        throw new BadRequestException('One or more dashboards do not exist');
      }
    }

    await tx(async (c) => {
      await c.query(`DELETE FROM sd_user_dashboard_access WHERE user_id = $1`, [id]);
      for (const a of dto.assignments) {
        await c.query(
          `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = EXCLUDED.effect,
                                                             granted_by = EXCLUDED.granted_by`,
          [id, a.dashboardId, a.effect, actor.id]);
      }
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.user.dashboards_changed',
      entityType: 'user', entityId: id, payload: dto.assignments,
    });
    return this.get(id);
  }

  /**
   * Soft delete. The row stays because this person organised meetings and
   * appears in the audit trail, and both should keep resolving to a name
   * rather than to a missing foreign key.
   */
  async remove(actor: Principal, id: string): Promise<{ ok: true }> {
    const before = await this.get(id);
    assertNotSelf(actor.id, id, 'delete');
    await assertSomebodyIsLeft(id, false, 'Deleting this account');
    await assertDepartmentKeepsAManager(null, [id], 'Deleting this account');

    await tx(async (c) => {
      await c.query(
        `UPDATE core_users SET status = 'SUSPENDED', deleted_at = now() WHERE id = $1`, [id]);
      await c.query(`DELETE FROM core_refresh_tokens WHERE user_id = $1`, [id]);
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.user.deleted',
      entityType: 'user', entityId: id, payload: { email: before.email },
    });
    return { ok: true };
  }

  private async assertRolesExist(roleIds: string[]): Promise<void> {
    if (!roleIds.length) return;
    const unique = [...new Set(roleIds)];
    const found = await query(`SELECT id FROM core_roles WHERE id = ANY($1)`, [unique]);
    if (found.length !== unique.length) throw new BadRequestException('One or more roles do not exist');
  }

  /** Departments, for the person form's picker. */
  async departments() {
    return query(
      `SELECT d.id, d.name,
              (SELECT COUNT(*)::int FROM core_users u
                WHERE u.department_id = d.id AND u.deleted_at IS NULL) AS head_count
         FROM core_departments d ORDER BY d.name`);
  }

  /** Dashboards, for the assignment list. */
  async dashboards() {
    return query(
      `SELECT id, key, name, description FROM sd_dashboards
        WHERE deleted_at IS NULL ORDER BY name`);
  }
}

export { CORE_PERMISSIONS };
