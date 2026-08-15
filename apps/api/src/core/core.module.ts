/**
 * The core platform. Owns identity, RBAC, the employee directory, the audit
 * trail, notifications and the module registry. Feature modules consume these
 * through services rather than touching core_* tables directly -- that single
 * rule is what keeps a module removable.
 */
import {
  Body, Controller, Get, Injectable, Module, Post, Query, Req,
  UnauthorizedException, BadRequestException,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { config } from '../common/config';
import { query, one } from '../common/db';
import { CurrentUser, Principal, Public, loadPrincipal } from '../common/auth';
import { resolveForPrincipal } from './hub-registry';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/* --------------------------------------------------------------- audit -- */

@Injectable()
export class AuditService {
  /** Append-only. Every module writes here, and only through this service. */
  async write(e: {
    actorId?: string | null; moduleKey?: string; action: string;
    entityType?: string; entityId?: string; payload?: unknown; ip?: string | null;
  }) {
    await query(
      `INSERT INTO core_audit_logs (actor_id, module_key, action, entity_type, entity_id, payload, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.actorId ?? null, e.moduleKey ?? null, e.action, e.entityType ?? null,
       e.entityId ?? null, e.payload ? JSON.stringify(e.payload) : null, e.ip ?? null],
    );
  }
}

@Injectable()
export class NotificationsService {
  async notify(userId: string, moduleKey: string, title: string,
               body?: string, severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'INFO',
               link?: string) {
    await query(
      `INSERT INTO core_notifications (user_id, module_key, severity, title, body, link)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, moduleKey, severity, title, body ?? null, link ?? null],
    );
  }

  /** Fan out to everyone holding a permission -- used for sync alerts. */
  async notifyPermissionHolders(permissionKey: string, moduleKey: string,
                                title: string, body?: string,
                                severity: 'INFO' | 'WARNING' | 'CRITICAL' = 'WARNING') {
    const users = await query(
      `SELECT DISTINCT u.id FROM core_users u
         JOIN core_user_roles ur ON ur.user_id = u.id
         JOIN core_role_permissions rp ON rp.role_id = ur.role_id
         JOIN core_permissions p ON p.id = rp.permission_id
        WHERE p.key = $1 AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
      [permissionKey],
    );
    for (const u of users) await this.notify(u.id, moduleKey, title, body, severity);
  }
}

/* ---------------------------------------------------------------- auth -- */

@Injectable()
export class AuthService {
  constructor(private jwt: JwtService, private audit: AuditService) {}

  async login(email: string, password: string, ip?: string) {
    const user = await one(
      `SELECT * FROM core_users WHERE email = $1 AND deleted_at IS NULL`, [email],
    );

    // A sign-in against an unknown address still performs a hash comparison, so
    // response timing does not disclose whether an account exists.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(password, hash);

    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked. Try again shortly.');
    }
    if (!user || !ok || user.status !== 'ACTIVE') {
      if (user) {
        const failed = user.failed_login_count + 1;
        const lock = failed >= config.security.maxFailedLogins;
        await query(
          `UPDATE core_users SET failed_login_count = $2,
             locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
           WHERE id = $1`,
          [user.id, lock ? 0 : failed, lock, String(config.security.lockoutMinutes)],
        );
        await this.audit.write({
          actorId: user.id, moduleKey: 'core', action: 'auth.login.failed', ip,
          payload: { attempt: failed, locked: lock },
        });
      }
      throw new UnauthorizedException('Incorrect e-mail or password');
    }

    await query(
      `UPDATE core_users SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`, [user.id],
    );
    await this.audit.write({ actorId: user.id, moduleKey: 'core', action: 'auth.login', ip });
    return this.issue(user.id, ip);
  }

  /** Access token plus an opaque single-use refresh token stored as a hash. */
  private async issue(userId: string, ip?: string) {
    const principal = await loadPrincipal(userId);
    if (!principal) throw new UnauthorizedException();

    const accessToken = await this.jwt.signAsync(
      { sub: userId, email: principal.email },
      { expiresIn: config.jwt.accessTtlSeconds },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await query(
      `INSERT INTO core_refresh_tokens (user_id, token_hash, ip, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [userId, sha256(refreshToken), ip ?? null, String(config.jwt.refreshTtlDays)],
    );
    return { accessToken, refreshToken, expiresIn: config.jwt.accessTtlSeconds, principal };
  }

  async refresh(refreshToken: string, ip?: string) {
    const row = await one(
      `SELECT * FROM core_refresh_tokens WHERE token_hash = $1`, [sha256(refreshToken)],
    );
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      throw new UnauthorizedException('Refresh token is not valid');
    }
    if (row.used_at) {
      // Presenting an already-used token is treated as evidence of theft:
      // revoke every session for that user rather than just this one.
      await query(
        `UPDATE core_refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id],
      );
      await this.audit.write({
        actorId: row.user_id, moduleKey: 'core',
        action: 'auth.refresh.replay_detected', ip,
      });
      throw new UnauthorizedException('Session revoked');
    }
    await query(
      `UPDATE core_refresh_tokens SET used_at = now(), revoked_at = now() WHERE id = $1`,
      [row.id],
    );
    return this.issue(row.user_id, ip);
  }

  async logout(refreshToken: string) {
    await query(
      `UPDATE core_refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
      [sha256(refreshToken)],
    );
    return { ok: true };
  }
}

/* --------------------------------------------------------- controllers -- */

const ipOf = (req: any) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '').trim() || null;

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Post('login')
  login(@Body() body: { email: string; password: string }, @Req() req: any) {
    if (!body?.email || !body?.password) throw new BadRequestException('E-mail and password are required');
    return this.auth.login(String(body.email).trim(), String(body.password), ipOf(req));
  }

  @Public() @Post('refresh')
  refresh(@Body() body: { refreshToken: string }, @Req() req: any) {
    if (!body?.refreshToken) throw new BadRequestException('refreshToken is required');
    return this.auth.refresh(body.refreshToken, ipOf(req));
  }

  @Public() @Post('logout')
  logout(@Body() body: { refreshToken: string }) {
    return this.auth.logout(body?.refreshToken ?? '');
  }

  @Get('me')
  me(@CurrentUser() principal: Principal) { return principal; }
}

@Controller('hub')
export class HubController {
  /** The portal shell renders whatever this returns. No hard-coded menu. */
  @Get('modules')
  modules(@CurrentUser() principal: Principal) {
    return resolveForPrincipal(principal.permissions);
  }

  @Get('notifications')
  async notifications(@CurrentUser() p: Principal, @Query('limit') limit = '20') {
    const rows = await query(
      `SELECT id, module_key, severity, title, body, link, read_at, created_at
         FROM core_notifications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [p.id, Math.min(parseInt(String(limit), 10) || 20, 100)],
    );
    return { notifications: rows };
  }
}

@Controller('users')
export class UsersController {
  /** Employee directory search, reused by the attendee picker and the
   *  dashboard-assignment screen. */
  @Get()
  async search(@Query('q') q = '', @Query('limit') limit = '20') {
    const rows = await query(
      `SELECT id, full_name, full_name_ar, email, job_title
         FROM core_users
        WHERE deleted_at IS NULL AND status = 'ACTIVE'
          AND ($1 = '' OR full_name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%')
        ORDER BY full_name LIMIT $2`,
      [String(q), Math.min(parseInt(String(limit), 10) || 20, 100)],
    );
    return { users: rows.map((r) => ({
      id: r.id, fullName: r.full_name, fullNameAr: r.full_name_ar,
      email: r.email, jobTitle: r.job_title,
    })) };
  }
}

@Controller()
export class HealthController {
  /** Liveness plus a real database round-trip -- the right target for a load
   *  balancer and for an external uptime monitor. */
  @Public() @Get('health')
  async health() {
    const t0 = Date.now();
    await query('SELECT 1');
    return { status: 'ok', database: 'ok', dbLatencyMs: Date.now() - t0,
             at: new Date().toISOString() };
  }
}

@Module({
  imports: [JwtModule.register({
    secret: config.jwt.secret,
    signOptions: { expiresIn: config.jwt.accessTtlSeconds },
  })],
  controllers: [AuthController, HubController, UsersController, HealthController],
  providers: [AuthService, AuditService, NotificationsService],
  exports: [JwtModule, AuditService, NotificationsService],
})
export class CoreModule {}
