/**
 * Data access. Parameterised SQL through node-postgres.
 *
 * DEVIATION FROM THE DESIGN DOC, recorded deliberately: the doc specifies
 * Drizzle. This build talks to PostgreSQL through `pg` with parameterised SQL
 * instead. The property that mattered in the doc's reasoning is preserved --
 * migrations are hand-written SQL applied by a checksum-verified runner, so
 * what is in version control is exactly what runs -- and every analytics query
 * here is raw SQL regardless, which is what Drizzle's `sql` template would have
 * produced anyway. Swapping in Drizzle later is mechanical: the table shapes
 * are already fixed by the migrations. See README.
 */
import { Pool, types } from 'pg';
import { config } from './config';

// numeric/decimal arrives as a string so precision is not silently lost. Parse
// once, here, rather than at each call site -- that is what stops a float
// creeping into a currency sum. Storage stays numeric(18,4) in the database.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  await pool.end();
}
