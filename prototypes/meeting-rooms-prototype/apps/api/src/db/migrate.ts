/**
 * Minimal, dependency-free SQL migration runner.
 *
 * Every .sql file in ./migrations is applied once, in filename order, inside a
 * transaction, and recorded in core_migrations. Running it twice is a no-op,
 * which makes it safe to call from the systemd unit on every deploy.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop the schema and re-apply from zero
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function main() {
  const reset = process.argv.includes('--reset');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    if (reset) {
      console.log('!  --reset: dropping and recreating schema "public"');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS core_migrations (
        id          serial PRIMARY KEY,
        name        varchar(255) NOT NULL UNIQUE,
        checksum    varchar(64)  NOT NULL,
        applied_at  timestamptz  NOT NULL DEFAULT now()
      );
    `);

    const applied = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM core_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let pending = 0;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration "${file}" was modified after it was applied. ` +
              `Create a new migration file instead of editing an applied one.`,
          );
        }
        continue;
      }

      process.stdout.write(`→ applying ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO core_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        console.log('done');
        pending++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }

    console.log(pending === 0 ? '✓ database already up to date' : `✓ applied ${pending} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
