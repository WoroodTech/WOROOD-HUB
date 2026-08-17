import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE } from '../../common/database.module';
import type { Database } from '../../db/client';
import { auditLogs } from '../../db/schema';

export interface AuditEntry {
  actorUserId?: string | null;
  moduleKey: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Append-only activity trail shared by every module.
 * Failures are logged but never propagate — an audit write must not be able
 * to fail a business transaction the user already completed.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        actorUserId: entry.actorUserId ?? null,
        moduleKey: entry.moduleKey,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ?? null,
        ipAddress: entry.ipAddress ?? null,
      });
    } catch (error) {
      this.logger.error(`Failed to write audit entry ${entry.moduleKey}/${entry.action}`, error as Error);
    }
  }
}
