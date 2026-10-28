#!/usr/bin/env node
// Contract and migration drift checks (CI-015, #149).
//
//   node scripts/check-drift.mjs stale              generated artifacts match what is committed
//   node scripts/check-drift.mjs immutable <base>   already-committed migrations are unchanged
//   node scripts/check-drift.mjs apply              apply every migration to a throwaway Postgres
//
// `stale` runs after `pnpm openapi:generate`, `pnpm graphql:generate` and `pnpm db:generate`
// (drizzle-kit generate) have rewritten the tree: any modified or new file under an artifact
// path means the author forgot to regenerate and commit.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Committed generated contracts and what regenerates them. */
export const ARTIFACTS = [
  { name: 'OpenAPI 3.1 spec', path: 'apps/api/openapi', fix: 'pnpm openapi:generate' },
  { name: 'OpenAPI 3.1 spec', path: 'docs/api/openapi.json', fix: 'pnpm openapi:generate' },
  { name: 'API reference', path: 'docs/api/reference.md', fix: 'pnpm openapi:generate' },
  { name: 'GraphQL SDL', path: 'apps/api/schema.gql', fix: 'pnpm graphql:generate' },
  {
    name: 'Typed API client',
    path: 'packages/api-client/src/generated',
    fix: 'pnpm --filter @blackwing/api-client api-client:gen',
  },
  {
    name: 'Drizzle migrations',
    path: 'packages/db/migrations',
    fix: 'pnpm db:generate (then review and commit the new migration)',
  },
];
export const MIGRATIONS_DIR = 'packages/db/migrations';
export const SQUASH_LABEL = 'migration-squash';
const PORCELAIN_PREFIX = 3; // 'XY ' status columns before the path

/**
 * @param {string} porcelain output of `git status --porcelain -- <artifact paths>`
 * @returns {string[]} one actionable message per stale artifact
 */
export function staleArtifacts(porcelain) {
  const files = porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(PORCELAIN_PREFIX).replace(/^"|"$/g, ''));
  /** @type {string[]} */
  const errors = [];
  for (const artifact of ARTIFACTS) {
    const hits = files.filter((f) => f === artifact.path || f.startsWith(`${artifact.path}/`));
    if (hits.length > 0) {
      errors.push(
        `${artifact.name} is stale (${hits.join(', ')}). Run \`${artifact.fix}\` and commit the result.`,
      );
    }
  }
  return errors;
}

/**
 * Forward-only: within the migrations dir only additions are allowed.
 * @param {string} nameStatus output of `git diff --name-status --no-renames <base>...HEAD`
 * @param {{ allowSquash?: boolean }} [options] allowSquash: the PR carries the squash label
 * @returns {string[]} problems
 */
export function editedMigrations(nameStatus, options = {}) {
  if (options.allowSquash === true) return [];
  /** @type {string[]} */
  const errors = [];
  for (const line of nameStatus.split('\n')) {
    const [status, file] = line.split('\t');
    if (status === undefined || file === undefined || status === 'A') continue;
    if (!file.startsWith(`${MIGRATIONS_DIR}/`)) continue;
    // drizzle's meta/_journal.json legitimately changes whenever a migration is appended.
    if (file.endsWith('/_journal.json')) continue;
    errors.push(
      `${file} was ${status === 'D' ? 'deleted' : 'modified'}, but applied migrations are immutable (forward-only). ` +
        `Add a new migration instead; a deliberate baseline squash needs the '${SQUASH_LABEL}' label.`,
    );
  }
  return errors;
}

/** @param {string} root */
export function migrationFiles(root) {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** @param {string[]} errors */
function report(errors) {
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '' && errors.length > 0) {
    appendFileSync(
      summary,
      `### Drift check failed\n\n${errors.map((e) => `- ${e}`).join('\n')}\n`,
    );
  }
  return errors.length === 0 ? 0 : 1;
}

/**
 * Applies each migration in order to the database at `databaseUrl` via psql.
 * @param {string} root
 * @param {string} databaseUrl
 * @param {string} [psql] psql binary (overridable for tests)
 * @returns {string[]} problems
 */
export function applyMigrations(root, databaseUrl, psql = 'psql') {
  /** @type {string[]} */
  const errors = [];
  for (const file of migrationFiles(root)) {
    const r = spawnSync(
      psql,
      [databaseUrl, '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', file],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, PGCONNECT_TIMEOUT: '15' } },
    );
    if (r.status !== 0) {
      errors.push(`Migration ${path.relative(root, file)} failed to apply: ${r.stderr.trim()}`);
      break;
    }
  }
  return errors;
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 */
export function main(argv, root = process.cwd()) {
  const [command, arg] = argv;
  try {
    if (command === 'stale') {
      const paths = ARTIFACTS.map((a) => a.path);
      return report(staleArtifacts(git(root, ['status', '--porcelain', '--', ...paths])));
    }
    if (command === 'immutable') {
      if (arg === undefined) throw new Error('usage: immutable <base-ref>');
      const out = git(root, [
        'diff',
        '--name-status',
        '--no-renames',
        `${arg}...HEAD`,
        '--',
        MIGRATIONS_DIR,
      ]);
      const allowSquash = process.env.BW_MIGRATION_SQUASH === 'true';
      return report(editedMigrations(out, { allowSquash }));
    }
    if (command === 'apply') {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === '') throw new Error('DATABASE_URL is required');
      return report(applyMigrations(root, url));
    }
    throw new Error('usage: check-drift.mjs stale | immutable <base-ref> | apply');
  } catch (error) {
    return report([error instanceof Error ? error.message : String(error)]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
