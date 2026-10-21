// Schema-vs-migrations drift (DB-002): runs `drizzle-kit generate` against a throwaway COPY of the
// committed migrations. If it emits a migration, the schema in src/schema/** changed without a
// committed migration. The committed folder is never touched, so the check is safe to run anywhere.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The schema entry drizzle-kit reads (same as src/drizzle.config.ts). */
export const SCHEMA_ENTRY = fileURLToPath(new URL('../schema/index.ts', import.meta.url));

/** A generous bound: drizzle-kit prompts (e.g. "is this a rename?") would otherwise hang CI. */
const GENERATE_TIMEOUT_MS = 120_000;

/** How many trailing lines of drizzle-kit output an error keeps. */
const ERROR_TAIL_LINES = 5;

/** What `drizzle-kit generate` would add to the committed migrations. */
export interface SchemaDrift {
  /** Migration files drizzle-kit generated, with their SQL. Empty when schema and migrations agree. */
  readonly generated: readonly { readonly file: string; readonly sql: string }[];
  /** Set when drizzle-kit itself failed or waited for input (also drift: it needs a human). */
  readonly error?: string;
}

/** drizzle-kit's message when the schema matches the latest snapshot. */
const NO_CHANGES = 'No schema changes';

function tail(output: string): string {
  return output.trim().split('\n').slice(-ERROR_TAIL_LINES).join('\n');
}

function drizzleKitBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('drizzle-kit')), 'bin.cjs');
}

/**
 * Generates migrations for `schemaPath` on top of a temporary copy of `migrationsDir` and returns
 * the files drizzle-kit added. stdin is closed, so an interactive prompt fails instead of hanging.
 */
export function detectSchemaDrift(migrationsDir: string, schemaPath = SCHEMA_ENTRY): SchemaDrift {
  const work = mkdtempSync(path.join(tmpdir(), 'bw-db-drift-'));
  const out = path.join(work, 'migrations');
  try {
    cpSync(migrationsDir, out, { recursive: true });
    const before = new Set(readdirSync(out));
    const result = spawnSync(
      process.execPath,
      [
        drizzleKitBin(),
        'generate',
        '--dialect=postgresql',
        // drizzle-kit resolves both paths relative to its cwd (it prefixes `./`), so pass relative ones.
        `--schema=${path.relative(work, schemaPath)}`,
        '--out=migrations',
        '--prefix=timestamp',
      ],
      {
        cwd: work,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GENERATE_TIMEOUT_MS,
        env: { PATH: process.env.PATH ?? '', HOME: work, TZ: 'UTC', NO_COLOR: '1' },
      },
    );
    const generated = readdirSync(out)
      .filter((file) => file.endsWith('.sql') && !before.has(file))
      .toSorted()
      .map((file) => ({ file, sql: readFileSync(path.join(out, file), 'utf8') }));
    const output = `${result.stdout}\n${result.stderr}`;
    // Fail closed: drizzle-kit can exit 0 after an internal error, so "no drift" needs its explicit
    // "No schema changes" message, and anything else without a new migration is an error.
    if (result.status === 0 && generated.length === 0 && !output.includes(NO_CHANGES)) {
      return {
        generated,
        error: `drizzle-kit generate did not confirm the result: ${tail(output)}`,
      };
    }
    if (result.status !== 0) {
      return {
        generated,
        error: `drizzle-kit generate exited ${String(result.status ?? result.signal)}: ${tail(output)}`,
      };
    }
    return { generated };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
