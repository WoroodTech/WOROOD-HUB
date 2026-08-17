import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../common/database.module';
import type { Database } from '../../db/client';
import { CurrentUser, Public, type AuthenticatedUser } from '../../common/auth';
import { getHubModules } from './module-registry';

@ApiTags('Hub')
@Controller({ path: 'hub', version: '1' })
export class HubController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The portal shell calls this on boot and renders its navigation and
   * dashboard entirely from the response — no hard-coded menu in the frontend,
   * which is what lets a new module appear without touching the shell.
   */
  @Get('modules')
  @ApiOperation({ summary: 'Modules, navigation and portlets visible to this user' })
  modules(@CurrentUser() user: AuthenticatedUser) {
    const visible = (required?: string[]) =>
      !required || required.length === 0 || required.some((p) => user.permissions.includes(p));

    return {
      data: getHubModules().map((module) => ({
        key: module.key,
        name: module.name,
        nameAr: module.nameAr,
        description: module.description,
        version: module.version,
        icon: module.icon,
        apiPrefix: module.apiPrefix,
        navigation: module.navigation.filter((n) => visible(n.requiresAnyPermission)),
        portlets: module.portlets
          .filter((p) => visible(p.requiresAnyPermission))
          .sort((a, b) => a.order - b.order),
      })),
    };
  }
}

@ApiTags('Hub')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Target of the EC2/ALB health check. Verifies the DB round-trip too. */
  @Public()
  @Get()
  async health() {
    const startedAt = Date.now();
    let database = 'up';
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      latencyMs: Date.now() - startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.APP_VERSION ?? '0.1.0',
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [HubController, HealthController] })
export class HubModule {}
