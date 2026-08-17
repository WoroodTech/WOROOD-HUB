import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { db, pool } from '../db/client';

export const DRIZZLE = Symbol('DRIZZLE');

/**
 * Global so every module injects the same pooled connection with
 * `@Inject(DRIZZLE) private readonly db: Database`.
 */
@Global()
@Module({
  providers: [{ provide: DRIZZLE, useValue: db }],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await pool.end().catch(() => undefined);
  }
}
