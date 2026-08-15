/**
 * Zero-dependency .env loader.
 *
 * In production the systemd unit supplies an EnvironmentFile, so the process
 * already has everything it needs and this is a no-op: variables that are
 * already set are never overwritten. Locally there is no systemd, and without
 * this the process silently falls back to the defaults in config.ts — which
 * produces a `28P01 password authentication failed` that points nowhere near
 * its cause.
 *
 * Imported for side effect at the top of config.ts, so it runs before any
 * process.env read, whether the entrypoint is main.ts, worker.ts, migrate.ts,
 * seed.ts or the test harness.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Walk up from this file looking for the first .env. Works from src/ and dist/. */
function findEnvFile(): string | null {
  const explicit = process.env.ENV_FILE;
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;

  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (quoted && value.length >= 2) {
      const quote = value[0];
      value = value.slice(1, -1);
      // Only double quotes carry escapes, matching shell semantics.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Unquoted values end at an inline comment.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export function loadEnv(): void {
  const file = findEnvFile();
  if (!file) return;

  for (const [key, value] of Object.entries(parse(readFileSync(file, 'utf8')))) {
    // The real environment always wins: systemd, Docker and CI stay authoritative.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
