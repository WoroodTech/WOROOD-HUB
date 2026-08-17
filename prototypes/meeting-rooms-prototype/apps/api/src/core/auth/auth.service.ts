import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../common/database.module';
import type { Database } from '../../db/client';
import { refreshTokens, rolePermissions, permissions, roles, userRoles, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import type { AccessTokenPayload } from '../../common/auth';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    employeeNo: string;
    email: string;
    fullName: string;
    jobTitle: string | null;
    avatarUrl: string | null;
    timezone: string;
    locale: string;
    mustChangePassword: boolean;
    roles: string[];
    permissions: string[];
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------------------- */
  /* Password helpers                                                       */
  /* --------------------------------------------------------------------- */

  static hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, 12);
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /* --------------------------------------------------------------------- */
  /* Effective permissions = union of every role's permissions              */
  /* --------------------------------------------------------------------- */

  async resolveAccess(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
    const rows = await this.db
      .select({ roleKey: roles.key, permissionKey: permissions.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, userId));

    const roleKeys = new Set<string>();
    const permissionKeys = new Set<string>();
    for (const row of rows) {
      roleKeys.add(row.roleKey);
      if (row.permissionKey) permissionKeys.add(row.permissionKey);
    }
    return { roles: [...roleKeys], permissions: [...permissionKeys] };
  }

  /* --------------------------------------------------------------------- */
  /* Login                                                                  */
  /* --------------------------------------------------------------------- */

  async login(
    email: string,
    password: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email.trim()), isNull(users.deletedAt)))
      .limit(1);

    // Constant-ish response regardless of whether the account exists.
    if (!user) {
      bcrypt.compareSync(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        `Account locked until ${user.lockedUntil.toISOString()} after repeated failed sign-ins`,
      );
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is not active. Contact IT.');
    }

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      const failed = user.failedLoginCount + 1;
      await this.db
        .update(users)
        .set({
          failedLoginCount: failed,
          lockedUntil:
            failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        })
        .where(eq(users.id, user.id));

      await this.audit.record({
        actorUserId: user.id,
        moduleKey: 'core',
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        metadata: { attempt: failed },
        ipAddress: context.ip,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    const access = await this.resolveAccess(user.id);
    const tokens = await this.issueTokens(user.id, user.email, user.fullName, access, context);

    await this.audit.record({
      actorUserId: user.id,
      moduleKey: 'core',
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: context.ip,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        employeeNo: user.employeeNo,
        email: user.email,
        fullName: user.fullName,
        jobTitle: user.jobTitle,
        avatarUrl: user.avatarUrl,
        timezone: user.timezone,
        locale: user.locale,
        mustChangePassword: user.mustChangePassword,
        roles: access.roles,
        permissions: access.permissions,
      },
    };
  }

  /* --------------------------------------------------------------------- */
  /* Token issuing & rotation                                               */
  /* --------------------------------------------------------------------- */

  private async issueTokens(
    userId: string,
    email: string,
    fullName: string,
    access: { roles: string[]; permissions: string[] },
    context: { ip?: string; userAgent?: string },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const ttl = Number(process.env.JWT_ACCESS_TTL ?? 900);
    const payload: AccessTokenPayload = {
      sub: userId,
      email,
      name: fullName,
      roles: access.roles,
      perms: access.permissions,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: ttl,
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTtl = Number(process.env.JWT_REFRESH_TTL ?? 2_592_000);

    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: AuthService.hashToken(refreshToken),
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      ipAddress: context.ip ?? null,
      expiresAt: new Date(Date.now() + refreshTtl * 1000),
    });

    return { accessToken, refreshToken, expiresIn: ttl };
  }

  /**
   * Refresh tokens are single use: presenting one revokes it and issues a new
   * pair. Re-presenting a revoked token is treated as theft and kills every
   * session for that user.
   */
  async refresh(
    token: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const hash = AuthService.hashToken(token);
    const [stored] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);

    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      this.logger.warn(`Reuse of revoked refresh token for user ${stored.userId} — revoking all sessions`);
      await this.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, stored.userId), isNull(refreshTokens.revokedAt)));
      throw new UnauthorizedException('Refresh token already used');
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Account is no longer active');
    }

    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, stored.id));

    const access = await this.resolveAccess(user.id);
    return this.issueTokens(user.id, user.email, user.fullName, access, context);
  }

  async logout(token: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, AuthService.hashToken(token)));
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 10) {
      throw new BadRequestException('New password must be at least 10 characters');
    }
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    await this.db
      .update(users)
      .set({ passwordHash: AuthService.hashPassword(newPassword), mustChangePassword: false })
      .where(eq(users.id, userId));

    // Force every other device to sign in again.
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

    await this.audit.record({
      actorUserId: userId,
      moduleKey: 'core',
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: userId,
    });
  }

  /** Housekeeping: called by a scheduled job in production. */
  async purgeExpiredTokens(): Promise<number> {
    const result = await this.db.execute(
      sql`DELETE FROM core_refresh_tokens WHERE expires_at < now() - interval '7 days'`,
    );
    return result.rowCount ?? 0;
  }
}
