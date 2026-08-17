/**
 * The rails that stop an administrator locking everybody out.
 *
 * Every one of these is a server-side check. The console also hides the
 * relevant controls, but hiding a button is a courtesy and this is the rule --
 * a direct API call has to hit the same wall, and these are the calls most
 * worth making directly if you are curious or careless.
 *
 * The failure they prevent is not theoretical. `core.user.manage` is the only
 * way into this console; if the last account holding it is suspended, deleted,
 * or has its roles emptied, the system becomes unadministrable and the only
 * remedy is a database client. That is a bad afternoon, so it is refused here.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { query } from '../../common/db';
import { CORE_PERMISSIONS } from './permissions';

/** Active accounts that can still reach the console, ignoring one person. */
export async function otherAdministrators(excludingUserId: string): Promise<number> {
  const [row] = await query<{ count: number }>(
    `SELECT COUNT(DISTINCT u.id)::int AS count
       FROM core_users u
       JOIN core_user_roles ur       ON ur.user_id = u.id
       JOIN core_role_permissions rp ON rp.role_id = ur.role_id
       JOIN core_permissions p       ON p.id = rp.permission_id
      WHERE p.key = $1
        AND u.id <> $2
        AND u.status = 'ACTIVE'
        AND u.deleted_at IS NULL`,
    [CORE_PERMISSIONS.USER_MANAGE, excludingUserId],
  );
  return row?.count ?? 0;
}

/** Would this set of roles still let the holder into the console? */
export async function rolesGrantUserManage(roleIds: string[]): Promise<boolean> {
  if (!roleIds.length) return false;
  const [row] = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM core_role_permissions rp
       JOIN core_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY($1) AND p.key = $2`,
    [roleIds, CORE_PERMISSIONS.USER_MANAGE],
  );
  return (row?.count ?? 0) > 0;
}

/**
 * Refuse a change that would leave nobody able to administer the system.
 *
 * `stillAdminAfter` is what the target account would be able to do once the
 * change lands. If they keep the console, nothing is at risk regardless of who
 * else exists.
 */
export async function assertSomebodyIsLeft(
  targetUserId: string, stillAdminAfter: boolean, what: string,
): Promise<void> {
  if (stillAdminAfter) return;
  if (await otherAdministrators(targetUserId) > 0) return;
  throw new ConflictException(
    `${what} would leave nobody able to administer WOROOD HUB. ` +
    `Give another active account a role carrying "${CORE_PERMISSIONS.USER_MANAGE}" first.`,
  );
}

/**
 * Suspending or deleting yourself is refused separately from the rule above,
 * because it is nearly always a misclick rather than an intention, and the
 * message should say so rather than talking about permissions.
 */
export function assertNotSelf(actorId: string, targetId: string, what: string): void {
  if (actorId === targetId) {
    throw new BadRequestException(
      `You cannot ${what} your own account. Ask another administrator.`,
    );
  }
}
