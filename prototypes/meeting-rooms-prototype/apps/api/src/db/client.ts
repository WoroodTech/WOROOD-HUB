import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * A single pooled connection for the whole process.
 *
 * Pool sizing note: PostgreSQL costs roughly 5–10 MB per backend, so on a
 * 2 vCPU / 4 GB EC2 host we keep max ~15 per Node process. With two clustered
 * Node workers that is 30 backends, comfortably under the 100 default.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 15),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

export type Database = typeof db;
export { schema };
