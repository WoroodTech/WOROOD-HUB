/**
 * Platform authentication and authorisation primitives, shared by every module.
 *
 * Two separate checks, deliberately:
 *   - the JWT guard proves WHO is calling (identity, 15-minute token);
 *   - the permissions guard proves WHAT they may do (route-declared keys).
 *
 * Finer-grained authorisation that changes often -- which sales dashboards an
 * individual has been assigned -- is NOT here and NOT in the token. It is
 * resolved from PostgreSQL on every request that returns dashboards, which is
 * what lets an unassignment take effect on the next request with no logout.
 * A JWT-embedded approach would need a token blocklist to get the same result.
 */
import {
  CanActivate, ExecutionContext, Injectable, SetMetadata,
  UnauthorizedException, ForbiddenException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { query } from './db';

export interface Principal {
  id: string;
  email: string;
  fullName: string;
  fullNameAr?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  /**
   * The department *identifier*, alongside the display name that was already
   * here. Module 3 addresses work to a department rather than to a person, so
   * the name is no longer enough -- and a module that had to re-query for it
   * on every request would be asking the database a question the guard has
   * already answered.
   */
  departmentId?: string | null;
  timezone: string;
  locale: string;
  /**
   * Every department this person may act on: the ones they manage, plus
   * everything underneath those in the tree.
   *
   * Authority over a department is a POSITION, not a role. A role would be
   * company-wide, and the Marketing manager would be able to assign work
   * inside Customer Care. So core_department_managers decides the scope, and
   * the derived permission below only decides whether the button exists at
   * all. This is the same separation Module 1 already makes between holding
   * `reservation.manage-any` and owning the reservation you are editing.
   */
  managedDepartmentIds: string[];
  roles: string[];
  permissions: string[];
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
/** ANY semantics: the caller needs at least one of the listed keys. */
export const Permissions = (...keys: string[]) => SetMetadata(REQUIRED_PERMISSIONS, keys);

/**
 * Granted by managing a department rather than by a role assignment, which is
 * why it is added here rather than seeded into core_role_permissions. Note
 * that holding it says nothing about WHERE it applies -- every call site must
 * still check the target department against `managedDepartmentIds`. It exists
 * so the registry can filter navigation and portlets, which is a yes/no
 * question and cannot express scope.
 */
export const DERIVED_DEPARTMENT_MANAGER_PERMISSION = 'tasks.item.assign';

export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): Principal =>
    ctx.switchToHttp().getRequest().principal,
);

/** Effective permissions are the union of those attached to the user's roles. */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const rows = await query(
    `SELECT u.id, u.email, u.full_name, u.full_name_ar, u.job_title,
            u.timezone, u.locale, u.status, u.deleted_at,
            u.department_id, d.name AS department,
            COALESCE(ARRAY_AGG(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
            COALESCE(ARRAY_AGG(DISTINCT p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions,
            COALESCE(ARRAY(SELECT md.department_id
                             FROM core_user_managed_departments(u.id) md), '{}') AS managed_department_ids
       FROM core_users u
       LEFT JOIN core_departments d       ON d.id = u.department_id
       LEFT JOIN core_user_roles ur       ON ur.user_id = u.id
       LEFT JOIN core_roles r             ON r.id = ur.role_id
       LEFT JOIN core_role_permissions rp ON rp.role_id = r.id
       LEFT JOIN core_permissions p       ON p.id = rp.permission_id
      WHERE u.id = $1
      GROUP BY u.id, d.name`,
    [userId],
  );
  const r = rows[0];
  if (!r || r.deleted_at || r.status !== 'ACTIVE') return null;

  const permissions: string[] = r.permissions ?? [];
  const managedDepartmentIds: string[] = r.managed_department_ids ?? [];

  /* Managing a department is what makes somebody able to hand work out, so the
     permission is derived from the org chart rather than granted through a
     role. Union rather than push: an administrator may hold the key outright
     and must not end up with it twice. */
  if (managedDepartmentIds.length > 0
      && !permissions.includes(DERIVED_DEPARTMENT_MANAGER_PERMISSION)) {
    permissions.push(DERIVED_DEPARTMENT_MANAGER_PERMISSION);
  }

  return {
    id: r.id, email: r.email, fullName: r.full_name, fullNameAr: r.full_name_ar,
    jobTitle: r.job_title, department: r.department, departmentId: r.department_id,
    timezone: r.timezone, locale: r.locale,
    roles: r.roles ?? [], permissions, managedDepartmentIds,
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization || '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const principal = await loadPrincipal(payload.sub);
    if (!principal) throw new UnauthorizedException('Account is not active');
    req.principal = principal;
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS, [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;
    const principal: Principal = ctx.switchToHttp().getRequest().principal;
    if (!principal) throw new UnauthorizedException();
    if (!required.some((k) => principal.permissions.includes(k))) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}

export const can = (p: Principal | null | undefined, key: string): boolean =>
  !!p && p.permissions.includes(key);

/** Does this person run the given department, or something above it? */
export const managesDepartment = (
  p: Principal | null | undefined,
  departmentId: string | null | undefined,
): boolean =>
  !!p && !!departmentId && p.managedDepartmentIds.includes(departmentId);
