/**
 * Roles: what each one can do, and who holds it.
 *
 * A role is the only place a permission is handed out, which makes this the
 * highest-leverage screen in the portal: one checkbox here changes what a
 * dozen people can reach. So it returns holder counts alongside every role --
 * editing "Sales Manager" without knowing four people hold it is how a change
 * lands wider than intended.
 */

import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { one, query, tx } from '../../common/db';
import type { Principal } from '../../common/auth';
import { AuditService } from '../../core/core.module';
import { CORE_PERMISSIONS } from './permissions';
import { otherAdministrators } from './guards';
import type { SetRolePermissions, UpsertRole } from './dto';

export interface RoleView {
  id: string; key: string; name: string; nameAr: string | null; description: string | null;
  permissions: Array<{ key: string; moduleKey: string; description: string | null }>;
  holders: number;
  /** Whether holding this role opens the administration console. */
  grantsConsole: boolean;
}

const ROLE_SELECT = `
  SELECT r.id, r.key, r.name, r.name_ar, r.description,
         (SELECT COUNT(*)::int FROM core_user_roles ur
            JOIN core_users u ON u.id = ur.user_id
           WHERE ur.role_id = r.id AND u.deleted_at IS NULL) AS holders,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'key', p.key, 'moduleKey', p.module_key, 'description', p.description)
                     ORDER BY p.module_key, p.key)
              FROM core_role_permissions rp JOIN core_permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = r.id),
           '[]'::json) AS permissions
    FROM core_roles r`;

const toView = (r: any): RoleView => {
  const permissions = r.permissions ?? [];
  return {
    id: r.id, key: r.key, name: r.name, nameAr: r.name_ar, description: r.description,
    permissions, holders: r.holders ?? 0,
    grantsConsole: permissions.some((p: any) => p.key === CORE_PERMISSIONS.USER_MANAGE),
  };
};

@Injectable()
export class AdminRolesService {
  constructor(private readonly audit: AuditService) {}

  async list(): Promise<{ roles: RoleView[] }> {
    const rows = await query(`${ROLE_SELECT} ORDER BY r.name`);
    return { roles: rows.map(toView) };
  }

  async get(id: string): Promise<RoleView> {
    const row = await one(`${ROLE_SELECT} WHERE r.id = $1`, [id]);
    if (!row) throw new NotFoundException('No such role');
    return toView(row);
  }

  /** Who holds this role -- shown before you edit what it can do. */
  async holders(id: string) {
    return query(
      `SELECT u.id, u.full_name, u.email, u.status
         FROM core_user_roles ur JOIN core_users u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND u.deleted_at IS NULL
        ORDER BY u.full_name`, [id]);
  }

  /** The whole catalogue, grouped by the module that registered each key. */
  async permissionCatalogue() {
    const rows = await query(
      `SELECT key, module_key, description FROM core_permissions
        ORDER BY module_key, key`);
    return { permissions: rows.map((p) => ({
      key: p.key, moduleKey: p.module_key, description: p.description,
    })) };
  }

  async create(actor: Principal, dto: UpsertRole): Promise<RoleView> {
    const id = await tx(async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO core_roles (key, name, name_ar, description) VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [dto.key, dto.name, dto.nameAr ?? null, dto.description ?? null])).rows[0];
      } catch (e: any) {
        if (e.code === '23505') throw new ConflictException(`A role with key "${dto.key}" already exists`);
        throw e;
      }
      await this.replacePermissions(c, row.id, dto.permissionKeys ?? []);
      return row.id as string;
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.role.created',
      entityType: 'role', entityId: id,
      payload: { key: dto.key, permissionKeys: dto.permissionKeys ?? [] },
    });
    return this.get(id);
  }

  async update(actor: Principal, id: string, dto: Partial<UpsertRole>): Promise<RoleView> {
    const before = await this.get(id);

    const sets: string[] = [];
    const params: any[] = [];
    const set = (col: string, v: any) => {
      if (v === undefined) return;
      params.push(v); sets.push(`${col} = $${params.length}`);
    };
    set('key', dto.key); set('name', dto.name);
    set('name_ar', dto.nameAr); set('description', dto.description);

    await tx(async (c) => {
      if (sets.length) {
        params.push(id);
        try {
          await c.query(`UPDATE core_roles SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        } catch (e: any) {
          if (e.code === '23505') throw new ConflictException(`A role with key "${dto.key}" already exists`);
          throw e;
        }
      }
      if (dto.permissionKeys !== undefined) {
        await this.guardConsoleRemoval(before, dto.permissionKeys);
        await this.replacePermissions(c, id, dto.permissionKeys);
      }
    });

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.role.updated',
      entityType: 'role', entityId: id,
      payload: { changed: Object.keys(dto), permissionsFrom: before.permissions.map((p) => p.key) },
    });
    return this.get(id);
  }

  async setPermissions(actor: Principal, id: string, dto: SetRolePermissions): Promise<RoleView> {
    const before = await this.get(id);
    await this.guardConsoleRemoval(before, dto.permissionKeys);

    await tx((c) => this.replacePermissions(c, id, dto.permissionKeys));

    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.role.permissions_changed',
      entityType: 'role', entityId: id,
      payload: { from: before.permissions.map((p) => p.key), to: dto.permissionKeys },
    });
    return this.get(id);
  }

  /**
   * A role in use is not deleted. Removing it would silently strip permissions
   * from everyone holding it, and the cascade would do it without a word --
   * so the holder count is reported and the caller decides.
   */
  async remove(actor: Principal, id: string): Promise<{ ok: true }> {
    const role = await this.get(id);
    if (role.holders > 0) {
      throw new ConflictException(
        `${role.name} is held by ${role.holders} ${role.holders === 1 ? 'person' : 'people'}. ` +
        `Move them to another role first.`);
    }
    if (role.grantsConsole) {
      const others = await otherAdministrators('00000000-0000-0000-0000-000000000000');
      if (others === 0) {
        throw new ConflictException(
          'This is the only role that opens the administration console, and nobody else can. ' +
          'Create a replacement before deleting it.');
      }
    }
    await query(`DELETE FROM core_roles WHERE id = $1`, [id]);
    await this.audit.write({
      actorId: actor.id, moduleKey: 'core', action: 'core.role.deleted',
      entityType: 'role', entityId: id, payload: { key: role.key },
    });
    return { ok: true };
  }

  /**
   * Taking `core.user.manage` off a role is the one permission change that can
   * lock everyone out, so it is checked against who would be left.
   */
  private async guardConsoleRemoval(before: RoleView, nextKeys: string[]): Promise<void> {
    const stillGrants = nextKeys.includes(CORE_PERMISSIONS.USER_MANAGE);
    if (!before.grantsConsole || stillGrants || before.holders === 0) return;

    const holders = await this.holders(before.id);
    const active = holders.filter((h: any) => h.status === 'ACTIVE').map((h: any) => h.id);

    /* Everyone who would lose the console through this role. If even one of
       them keeps it another way, or somebody outside this role has it, we are
       fine. */
    for (const userId of active) {
      if (await otherAdministrators(userId) > 0) return;
    }
    throw new ConflictException(
      `Removing "${CORE_PERMISSIONS.USER_MANAGE}" from ${before.name} would leave nobody able to ` +
      `administer WOROOD HUB. Grant it to another role first.`);
  }

  private async replacePermissions(c: any, roleId: string, keys: string[]): Promise<void> {
    await c.query(`DELETE FROM core_role_permissions WHERE role_id = $1`, [roleId]);
    if (!keys.length) return;

    const { rows } = await c.query(
      `SELECT id, key FROM core_permissions WHERE key = ANY($1)`, [keys]);
    const found = new Set(rows.map((r: any) => r.key));
    const unknown = [...new Set(keys)].filter((k) => !found.has(k));
    if (unknown.length) throw new BadRequestException(`Unknown permissions: ${unknown.join(', ')}`);

    for (const r of rows) {
      await c.query(
        `INSERT INTO core_role_permissions (role_id, permission_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [roleId, r.id]);
    }
  }
}
