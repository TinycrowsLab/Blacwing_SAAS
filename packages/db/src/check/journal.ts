// Static checks of the committed migrations (DB-002, `pnpm db:check`). They catch what a git merge
// does not: two PRs that each added a migration (colliding prefixes, timestamps or snapshot parents),
// files missing from the journal, and SQL that would not be safe to re-run after a partial apply.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { stripSqlComments } from '../migrate-guard.js';

const journalSchema = z.object({
  dialect: z.literal('postgresql'),
  entries: z.array(
    z.object({ idx: z.int().nonnegative(), tag: z.string().min(1), when: z.number().int() }),
  ),
});

const snapshotSchema = z.object({ id: z.string().min(1), prevId: z.string().min(1) });

/** The `prevId` of the first snapshot (drizzle-kit's root). */
export const ROOT_SNAPSHOT_ID = '00000000-0000-0000-0000-000000000000';

const REBASE_HINT =
  'Two branches added migrations in parallel: rebase on main, delete your generated migration ' +
  '(its .sql, snapshot and journal entry), re-run `pnpm db:generate` and commit the result.';

/** The migration prefix (`0001`, or a timestamp such as `20261021093000`) of a journal tag. */
export function migrationPrefix(tag: string): string {
  return tag.split('_')[0] ?? tag;
}

/** Per-statement lint rules for SQL that cannot be (safely) transactional or must not be committed. */
const SQL_RULES: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /\bCREATE\s+EXTENSION\s+(?!\s|IF\s+NOT\s+EXISTS\b)/iu,
    message: 'CREATE EXTENSION must use IF NOT EXISTS (re-runnable after a partial apply)',
  },
  {
    pattern: /\bALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\s+(?!\s|IF\s+NOT\s+EXISTS\b)/iu,
    message: 'ALTER TYPE ... ADD VALUE must use IF NOT EXISTS (re-runnable after a partial apply)',
  },
  {
    pattern: /\bCONCURRENTLY\b/iu,
    message: 'CONCURRENTLY cannot run inside the migration transaction',
  },
  {
    pattern: /\b(?:VACUUM|CREATE\s+DATABASE|ALTER\s+SYSTEM)\b/iu,
    message: 'VACUUM, CREATE DATABASE and ALTER SYSTEM cannot run inside the migration transaction',
  },
  {
    pattern: /\bPASSWORD\s+'/iu,
    message: 'migrations must not contain credentials (roles get passwords from the secret store)',
  },
];

/** Lint problems in one migration's SQL. */
export function lintMigrationSql(tag: string, sql: string): string[] {
  const code = stripSqlComments(sql);
  return SQL_RULES.filter((rule) => rule.pattern.test(code)).map(
    (rule) => `${tag}.sql: ${rule.message}`,
  );
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Checks `dir` (a drizzle-kit migrations folder): a well-formed journal with contiguous indexes,
 * unique tags and prefixes and strictly increasing timestamps (the migrator skips a migration older
 * than the last applied one), a `.sql` file and a snapshot per entry and no stray `.sql` files, one
 * linear snapshot chain (a fork means a merge of parallel migrations), and the SQL lint rules.
 */
export function checkMigrationsDir(dir: string): string[] {
  const journalFile = path.join(dir, 'meta', '_journal.json');
  if (!existsSync(journalFile)) return [`${journalFile} is missing`];
  const parsed = journalSchema.safeParse(readJson(journalFile));
  if (!parsed.success) return [`meta/_journal.json is malformed: ${parsed.error.message}`];
  const entries = parsed.data.entries;
  const problems: string[] = [];

  const seenTags = new Set<string>();
  const seenPrefixes = new Map<string, string>();
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push(
        `journal entry ${entry.tag} has idx ${String(entry.idx)}, expected ${String(position)}. ${REBASE_HINT}`,
      );
    }
    if (seenTags.has(entry.tag)) problems.push(`journal tag ${entry.tag} appears twice`);
    seenTags.add(entry.tag);
    const prefix = migrationPrefix(entry.tag);
    const other = seenPrefixes.get(prefix);
    if (other !== undefined && other !== entry.tag) {
      problems.push(
        `migrations ${other} and ${entry.tag} share the prefix ${prefix}. ${REBASE_HINT}`,
      );
    }
    seenPrefixes.set(prefix, entry.tag);
    const previous = entries[position - 1];
    if (previous !== undefined && entry.when <= previous.when) {
      problems.push(
        `migration ${entry.tag} is not newer than ${previous.tag} (journal "when"), so it would be skipped on databases that already applied ${previous.tag}. ${REBASE_HINT}`,
      );
    }
  });

  const sqlFiles = readdirSync(dir).filter((file) => file.endsWith('.sql'));
  for (const file of sqlFiles) {
    if (!seenTags.has(file.slice(0, -'.sql'.length))) {
      problems.push(
        `${file} is not in meta/_journal.json (generate migrations with pnpm db:generate)`,
      );
    }
  }

  const parents = new Map<string, string>();
  let expectedPrevId = ROOT_SNAPSHOT_ID;
  for (const entry of entries) {
    const sqlFile = path.join(dir, `${entry.tag}.sql`);
    if (existsSync(sqlFile)) {
      problems.push(...lintMigrationSql(entry.tag, readFileSync(sqlFile, 'utf8')));
    } else {
      problems.push(`${entry.tag}.sql is in the journal but missing`);
    }
    const snapshotFile = path.join(dir, 'meta', `${migrationPrefix(entry.tag)}_snapshot.json`);
    if (!existsSync(snapshotFile)) {
      problems.push(`meta/${path.basename(snapshotFile)} (snapshot of ${entry.tag}) is missing`);
      continue;
    }
    const snapshot = snapshotSchema.safeParse(readJson(snapshotFile));
    if (!snapshot.success) {
      problems.push(`meta/${path.basename(snapshotFile)} is malformed`);
      continue;
    }
    const sibling = parents.get(snapshot.data.prevId);
    if (sibling !== undefined) {
      problems.push(
        `snapshots of ${sibling} and ${entry.tag} have the same parent (the history forked). ${REBASE_HINT}`,
      );
    } else if (snapshot.data.prevId !== expectedPrevId) {
      problems.push(
        `snapshot of ${entry.tag} does not follow the previous snapshot (prevId mismatch). ${REBASE_HINT}`,
      );
    }
    parents.set(snapshot.data.prevId, entry.tag);
    expectedPrevId = snapshot.data.id;
  }
  return problems;
}
