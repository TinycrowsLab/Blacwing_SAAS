// Forward-only Cypher migration runner for the surface graph (GRAPH-002, §5, §8.6). Migration files are
// `NNNN_name.cypher`, applied in lexical order. Each applied migration is recorded as a `_GraphMigration` node.
// Neo4j DDL is not transactional across statements, so the runner runs one statement per call and records the
// count of statements done. A restart resumes from that count. Every statement uses IF NOT EXISTS, so replaying
// the one statement that was in flight is safe. A migration file that changes after it was applied is drift:
// the runner refuses to continue rather than re-apply it.

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import neo4j, { type Integer } from 'neo4j-driver';
import { z } from 'zod';

import { AppError } from '@blackwing/errors';
import { nowIso } from '@blackwing/time';

import { type GraphLogger, getGraph, type GraphRuntime, withSessionOn } from './driver.js';

/** Directory of the committed migration files. */
export const GRAPH_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.cypher$/;
const CYPHER_EXTENSION = '.cypher';
const LOCK_NAME = 'surface-graph';
/** A lock whose holder died is taken over after this lease. Migrations are short, so ten minutes is generous. */
const DEFAULT_LEASE_MS = 600_000;

/**
 * Constraints the ledger and the lock rely on. They are created before the lock is taken (a MERGE is only
 * race-free under a uniqueness constraint). Both use IF NOT EXISTS, so every run may issue them.
 */
const BOOTSTRAP_STATEMENTS = [
  'CREATE CONSTRAINT graph_migration_id IF NOT EXISTS FOR (m:_GraphMigration) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT graph_migration_lock_name IF NOT EXISTS FOR (l:_GraphMigrationLock) REQUIRE l.name IS UNIQUE',
];

/** A migration file as loaded from disk. `id` is the file name without `.cypher`. */
export interface GraphMigration {
  readonly id: string;
  /** SHA-256 of the file's exact bytes (UTF-8). */
  readonly checksum: string;
  /** The file's statements in order. */
  readonly statements: readonly string[];
}

/** A `_GraphMigration` node. `statementsApplied` counts the statements of the file that have run. */
export interface LedgerEntry {
  readonly id: string;
  readonly checksum: string;
  readonly status: 'in_progress' | 'applied';
  readonly statementsApplied: number;
}

/** How the ledger and the files on disk compare. Produced without mutating anything. */
export interface GraphMigrationReport {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  /** Started but not finished. The next run resumes them. */
  readonly partial: readonly string[];
  /**
   * The ledger disagrees with the files: a checksum changed, or a file older than an applied one has no ledger
   * entry (out of sequence). Never re-applied; the run fails.
   */
  readonly drifted: readonly string[];
  /** Ledger entries with no file on disk. The run fails. */
  readonly missing: readonly string[];
}

/** The storage operations the runner needs. {@link neo4jMigrationStore} is the Neo4j implementation. */
export interface GraphMigrationStore {
  readLedger(): Promise<LedgerEntry[]>;
  /** Takes the lock if it is free, owned by `owner`, or its lease ended before `nowMs`. */
  acquireLock(owner: string, nowMs: number, leaseMs: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  /** Creates the ledger entry for a migration that has not started. */
  begin(id: string, checksum: string, startedAt: string): Promise<void>;
  /** Records that `statementsApplied` statements of the migration have run. */
  progress(id: string, statementsApplied: number): Promise<void>;
  complete(id: string, appliedAt: string): Promise<void>;
  /** Runs one statement. Statements take no parameters (DDL cannot be parameterised). */
  execute(statement: string): Promise<void>;
}

/** Hook for `graph_migrations_applied_total` (the default is a no-op). */
export interface GraphMigrationMetrics {
  migrationApplied(): void;
}

/** Options for {@link applyGraphMigrations}. */
export interface ApplyGraphMigrationsOptions {
  readonly logger: GraphLogger;
  readonly metrics?: GraphMigrationMetrics;
  /** Epoch milliseconds. Default: the system clock. */
  readonly now?: () => number;
  readonly leaseMs?: number;
}

const NOOP_METRICS: GraphMigrationMetrics = { migrationApplied: () => undefined };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Splits a migration file into statements. A line that starts with `//` is a comment. A statement ends at a `;`
 * that closes its line, so a `;` inside a line does not split. Empty pieces are dropped.
 */
export function parseCypherStatements(source: string): string[] {
  const body = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return body
    .split(/;[ \t]*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Loads every `NNNN_name.cypher` file in `dir`, in lexical order. A file name that does not match, a repeated
 * sequence number or a file with no statements fails with `GRAPH_MIGRATION_INVALID`.
 */
export function loadGraphMigrations(dir: string = GRAPH_MIGRATIONS_DIR): GraphMigration[] {
  const sequences = new Set<string>();
  return readdirSync(dir)
    .filter((file) => file.endsWith(CYPHER_EXTENSION))
    .sort()
    .map((file): GraphMigration => {
      const sequence = FILE_NAME.exec(file)?.[1];
      if (sequence === undefined || sequences.has(sequence)) {
        throw new AppError(
          'GRAPH_MIGRATION_INVALID',
          `graph migration file must be named NNNN_name.cypher with a unique NNNN: ${file}`,
        );
      }
      sequences.add(sequence);
      const source = readFileSync(join(dir, file), 'utf8');
      const statements = parseCypherStatements(source);
      if (statements.length === 0) {
        throw new AppError('GRAPH_MIGRATION_INVALID', `graph migration has no statements: ${file}`);
      }
      return {
        id: file.slice(0, -CYPHER_EXTENSION.length),
        checksum: sha256(source),
        statements,
      };
    });
}

/** Compares the files with the ledger. Pure: the same inputs always give the same status. */
export function compareGraphMigrations(
  migrations: readonly GraphMigration[],
  ledger: readonly LedgerEntry[],
): GraphMigrationReport {
  const entries = new Map(ledger.map((entry) => [entry.id, entry]));
  const fileIds = new Set(migrations.map((migration) => migration.id));
  const applied: string[] = [];
  const pending: string[] = [];
  const partial: string[] = [];
  const drifted: string[] = [];
  let sawPending = false;
  for (const migration of migrations) {
    const entry = entries.get(migration.id);
    if (entry === undefined) {
      pending.push(migration.id);
      sawPending = true;
    } else if (entry.checksum !== migration.checksum || sawPending) {
      drifted.push(migration.id);
    } else if (entry.status === 'applied') {
      applied.push(migration.id);
    } else {
      partial.push(migration.id);
    }
  }
  const missing = ledger.map((entry) => entry.id).filter((id) => !fileIds.has(id));
  return { applied, pending, partial, drifted, missing };
}

/** True when the ledger matches the files exactly: nothing pending, partial, drifted or missing. */
export function isGraphMigrationReportClean(status: GraphMigrationReport): boolean {
  return (
    status.pending.length === 0 &&
    status.partial.length === 0 &&
    status.drifted.length === 0 &&
    status.missing.length === 0
  );
}

/**
 * Applies the migrations the ledger does not show as applied, in order, under the migration lock. Returns the ids
 * this run finished. Drift or a missing file fails before anything is applied.
 */
export async function applyGraphMigrations(
  store: GraphMigrationStore,
  migrations: readonly GraphMigration[],
  options: ApplyGraphMigrationsOptions,
): Promise<string[]> {
  const { logger, metrics = NOOP_METRICS, now = Date.now, leaseMs = DEFAULT_LEASE_MS } = options;
  // Bootstrap runs before the lock: the lock's MERGE is only race-free once its constraint exists.
  for (const statement of BOOTSTRAP_STATEMENTS) await store.execute(statement);
  const owner = randomUUID();
  if (!(await store.acquireLock(owner, now(), leaseMs))) {
    throw new AppError('GRAPH_MIGRATION_LOCKED', 'another graph migration run holds the lock');
  }
  const finished: string[] = [];
  try {
    const ledger = await store.readLedger();
    const status = compareGraphMigrations(migrations, ledger);
    const problems = [...status.drifted, ...status.missing];
    if (problems.length > 0) {
      throw new AppError(
        'GRAPH_MIGRATION_DRIFT',
        `graph migration ledger disagrees with the files: ${problems.join(', ')}`,
      );
    }
    logger.info(
      { existence_constraints: 'application', edition: 'community' },
      'graph.migration.mode',
    );
    const entries = new Map(ledger.map((entry) => [entry.id, entry]));
    for (const migration of migrations) {
      const entry = entries.get(migration.id);
      if (entry?.status === 'applied') continue;
      const resumeFrom = entry?.statementsApplied ?? 0;
      if (entry === undefined) {
        await store.begin(migration.id, migration.checksum, nowIso());
      } else {
        logger.warn(
          { id: migration.id, resume_from_statement: resumeFrom },
          'graph.migration.resumed',
        );
      }
      const started = now();
      for (const [index, statement] of migration.statements.entries()) {
        if (index < resumeFrom) continue;
        try {
          await store.execute(statement);
        } catch (error) {
          logger.error(
            { id: migration.id, statement_index: index, error_name: errorName(error) },
            'graph.migration.failed',
          );
          throw error;
        }
        await store.progress(migration.id, index + 1);
      }
      await store.complete(migration.id, nowIso());
      finished.push(migration.id);
      metrics.migrationApplied();
      logger.info(
        { id: migration.id, checksum: migration.checksum, durationMs: now() - started },
        'graph.migration.applied',
      );
    }
    return finished;
  } finally {
    await store.releaseLock(owner);
  }
}

/** Read-only report of the ledger against the files on disk. Never mutates the graph. */
export async function checkGraphMigrationsOn(
  store: GraphMigrationStore,
  migrations: readonly GraphMigration[],
): Promise<GraphMigrationReport> {
  return compareGraphMigrations(migrations, await store.readLedger());
}

/** Error class name, safe to log. The message can name hosts, so it is never logged. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

const LEDGER_ROW = z.object({
  id: z.string(),
  checksum: z.string(),
  status: z.enum(['in_progress', 'applied']),
  statementsApplied: z.custom<Integer | number>(
    (value) => typeof value === 'number' || neo4j.isInt(value),
  ),
});

const READ_LEDGER = `MATCH (m:_GraphMigration)
RETURN m.id AS id, m.checksum AS checksum, m.status AS status, m.statementsApplied AS statementsApplied
ORDER BY m.id`;
// Only the holder or an expired lease may take the lock. The MERGE is race-free under the lock-name constraint.
const TRY_LOCK = `MERGE (l:_GraphMigrationLock {name: $name})
ON CREATE SET l.owner = $owner, l.expiresAtMs = $expiresAtMs
WITH l
WHERE l.owner = $owner OR l.expiresAtMs < $nowMs
SET l.owner = $owner, l.expiresAtMs = $expiresAtMs
RETURN l.owner AS owner`;
const RELEASE_LOCK = `MATCH (l:_GraphMigrationLock {name: $name, owner: $owner}) DELETE l`;
const BEGIN = `MERGE (m:_GraphMigration {id: $id})
ON CREATE SET m.checksum = $checksum, m.status = 'in_progress', m.statementsApplied = 0, m.startedAt = $startedAt`;
const PROGRESS = `MATCH (m:_GraphMigration {id: $id}) SET m.statementsApplied = $statementsApplied`;
const COMPLETE = `MATCH (m:_GraphMigration {id: $id}) SET m.status = 'applied', m.appliedAt = $appliedAt`;

/** The Neo4j implementation of {@link GraphMigrationStore}. Each call is its own session. */
export function neo4jMigrationStore(runtime: GraphRuntime): GraphMigrationStore {
  const write = (query: string, params: Record<string, unknown> = {}) =>
    withSessionOn(runtime, 'WRITE', (session) => session.run(query, params));
  return {
    readLedger: () =>
      withSessionOn(runtime, 'READ', async (session) => {
        const result = await session.run(READ_LEDGER);
        return result.records.map((record): LedgerEntry => {
          const row = LEDGER_ROW.parse(record.toObject());
          return {
            id: row.id,
            checksum: row.checksum,
            status: row.status,
            statementsApplied: neo4j.integer.toNumber(row.statementsApplied),
          };
        });
      }),
    acquireLock: async (owner, nowMs, leaseMs) => {
      const result = await write(TRY_LOCK, {
        name: LOCK_NAME,
        owner,
        nowMs,
        expiresAtMs: nowMs + leaseMs,
      });
      return result.records.length === 1;
    },
    releaseLock: async (owner) => {
      await write(RELEASE_LOCK, { name: LOCK_NAME, owner });
    },
    begin: async (id, checksum, startedAt) => {
      await write(BEGIN, { id, checksum, startedAt });
    },
    progress: async (id, statementsApplied) => {
      await write(PROGRESS, { id, statementsApplied });
    },
    complete: async (id, appliedAt) => {
      await write(COMPLETE, { id, appliedAt });
    },
    execute: async (statement) => {
      await write(statement);
    },
  };
}

/** Options for the runtime-level entry points. */
export interface GraphMigrationOptions {
  readonly migrations?: readonly GraphMigration[];
  readonly metrics?: GraphMigrationMetrics;
  readonly now?: () => number;
  readonly leaseMs?: number;
}

/**
 * Applies pending surface-graph migrations to the database of `runtime` (default: the process runtime). Safe at boot
 * and in CI. Returns the ids applied by this run.
 */
export async function runGraphMigrations(
  runtime: GraphRuntime = getGraph(),
  options: GraphMigrationOptions = {},
): Promise<string[]> {
  const migrations = options.migrations ?? loadGraphMigrations();
  return applyGraphMigrations(neo4jMigrationStore(runtime), migrations, {
    ...options,
    logger: runtime.logger,
  });
}

/** Reports applied, pending, partial, drifted and missing migrations. Never mutates the graph. */
export async function checkGraphMigrations(
  runtime: GraphRuntime = getGraph(),
  options: Pick<GraphMigrationOptions, 'migrations'> = {},
): Promise<GraphMigrationReport> {
  return checkGraphMigrationsOn(
    neo4jMigrationStore(runtime),
    options.migrations ?? loadGraphMigrations(),
  );
}
