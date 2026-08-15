/**
 * Checksum-verified migration runner. Plain numbered .sql files applied in order
 * inside a transaction; each file's name and SHA-256 are recorded in
 * core_migrations. Re-running is a no-op, so the systemd unit runs this in
 * ExecStartPre and a deploy that cannot migrate never begins serving traffic.
 * Editing an already-applied migration makes the runner refuse to start, which
 * is a cheap guard against the most common cause of environment drift.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../common/config';

const DIR = join(__dirname, 'migrations');

export async function migrate(silent = false): Promise<number> {
  const log = (s: string) => { if (!silent) console.log(s); };
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS core_migrations (
      id serial PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Map<string, string>();
  for (const r of (await client.query('SELECT filename, checksum FROM core_migrations')).rows) {
    applied.set(r.filename, r.checksum);
  }

  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    const sqlText = readFileSync(join(DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sqlText).digest('hex');
    const prior = applied.get(file);

    if (prior) {
      if (prior !== checksum) {
        console.error(
          `\n  Migration ${file} has changed since it was applied.\n` +
          `  Write a new migration instead of editing an applied one.\n`,
        );
        await client.end();
        process.exit(1);
      }
      continue;
    }

    if (!silent) process.stdout.write(`  applying ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sqlText);
      await client.query(
        'INSERT INTO core_migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      log('ok');
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      log('failed');
      console.error(e);
      await client.end();
      process.exit(1);
    }
  }

  log(ran === 0 ? '  database already up to date' : `  ${ran} migration(s) applied`);
  await client.end();
  return ran;
}

if (require.main === module) {
  migrate().catch((e) => { console.error(e); process.exit(1); });
}
