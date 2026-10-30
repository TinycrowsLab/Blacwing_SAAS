import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  applyGraphMigrations,
  checkGraphMigrationsOn,
  compareGraphMigrations,
  type GraphMigration,
  type GraphMigrationStore,
  type LedgerEntry,
  GRAPH_MIGRATIONS_DIR,
  isGraphMigrationReportClean,
  loadGraphMigrations,
  parseCypherStatements,
} from './migrate.js';

import type { GraphLogger } from './driver.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function migration(id: string, statements: string[], checksum = sha(id)): GraphMigration {
  return { id, checksum, statements };
}

const M1 = migration('0001_first', ['CREATE A', 'CREATE B', 'CREATE C']);
const M2 = migration('0002_second', ['CREATE D']);

function fakeLogger(): GraphLogger & {
  lines: { level: string; event: string; fields: unknown }[];
} {
  const lines: { level: string; event: string; fields: unknown }[] = [];
  const record =
    (level: string) =>
    (fields: unknown, event?: string): void => {
      lines.push({ level, event: String(event), fields });
    };
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

interface FakeStoreOptions {
  readonly ledger?: LedgerEntry[];
  /** Lock holder already present (another run). */
  readonly lockHeldBy?: { owner: string; expiresAtMs: number };
  /** Throws when this statement is executed. */
  readonly failOn?: string;
}

/** In-memory stand-in for the Neo4j store: same contract, same ledger semantics, no Cypher. */
function fakeStore(options: FakeStoreOptions = {}) {
  const ledger = new Map<string, LedgerEntry>(
    (options.ledger ?? []).map((entry) => [entry.id, entry]),
  );
  let lock: { owner: string; expiresAtMs: number } | undefined = options.lockHeldBy;
  const executed: string[] = [];
  const calls: string[] = [];
  const store: GraphMigrationStore = {
    readLedger: () => {
      calls.push('readLedger');
      return Promise.resolve([...ledger.values()].map((entry) => ({ ...entry })));
    },
    acquireLock: (owner, nowMs, leaseMs) => {
      calls.push('acquireLock');
      if (lock === undefined || lock.owner === owner || lock.expiresAtMs < nowMs) {
        lock = { owner, expiresAtMs: nowMs + leaseMs };
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    releaseLock: (owner) => {
      calls.push('releaseLock');
      if (lock?.owner === owner) lock = undefined;
      return Promise.resolve();
    },
    begin: (id, checksum) => {
      calls.push('begin');
      ledger.set(id, { id, checksum, status: 'in_progress', statementsApplied: 0 });
      return Promise.resolve();
    },
    progress: (id, statementsApplied) => {
      calls.push('progress');
      const entry = ledger.get(id);
      if (entry === undefined) throw new Error('no ledger entry');
      ledger.set(id, { ...entry, statementsApplied });
      return Promise.resolve();
    },
    complete: (id) => {
      calls.push('complete');
      const entry = ledger.get(id);
      if (entry === undefined) throw new Error('no ledger entry');
      ledger.set(id, { ...entry, status: 'applied' });
      return Promise.resolve();
    },
    execute: (statement) => {
      calls.push('execute');
      if (statement === options.failOn) {
        return Promise.reject(new Error('connection to graph.internal:7687 refused'));
      }
      executed.push(statement);
      return Promise.resolve();
    },
  };
  return {
    store,
    ledger,
    executed,
    calls,
    lock: () => lock,
  };
}

const NOW = 1_000_000;
const deps = (logger = fakeLogger(), metrics = { migrationApplied: vi.fn() }) => ({
  logger,
  metrics,
  now: () => NOW,
  leaseMs: 60_000,
});

const BOOTSTRAP_COUNT = 2;

/** The statements of the migration files, without the two bootstrap constraints on the ledger and lock. */
const work = (fake: { executed: string[] }): string[] =>
  fake.executed.filter((statement) => !statement.includes('_GraphMigration'));

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('parseCypherStatements', () => {
  it('splits statements on a semicolon that ends a line and drops comment lines', () => {
    const source = [
      '// header comment',
      'CREATE CONSTRAINT a IF NOT EXISTS',
      'FOR (n:A) REQUIRE (n.tenantId, n.id) IS UNIQUE;',
      '// between statements',
      'CREATE INDEX b IF NOT EXISTS FOR (n:B) ON (n.tenantId);',
      '',
    ].join('\n');
    expect(parseCypherStatements(source)).toEqual([
      'CREATE CONSTRAINT a IF NOT EXISTS\nFOR (n:A) REQUIRE (n.tenantId, n.id) IS UNIQUE',
      'CREATE INDEX b IF NOT EXISTS FOR (n:B) ON (n.tenantId)',
    ]);
  });

  it('keeps a final statement that has no trailing semicolon', () => {
    expect(parseCypherStatements('CREATE A;\nCREATE B')).toEqual(['CREATE A', 'CREATE B']);
  });

  it('does not split on a semicolon in the middle of a line', () => {
    expect(parseCypherStatements('RETURN 1; RETURN 2;')).toEqual(['RETURN 1; RETURN 2']);
  });

  it('handles CRLF line endings', () => {
    expect(parseCypherStatements('CREATE A;\r\nCREATE B;\r\n')).toEqual(['CREATE A', 'CREATE B']);
  });

  it('returns nothing for a file that holds only comments', () => {
    expect(parseCypherStatements('// nothing here\n')).toEqual([]);
  });
});

describe('loadGraphMigrations', () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bw-graph-migrations-'));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('loads files in lexical order, with the file name as id and the SHA-256 of its bytes', () => {
    const source = 'CREATE B;\n';
    const dir = dirWith({ '0002_b.cypher': source, '0001_a.cypher': 'CREATE A;\n' });
    const loaded = loadGraphMigrations(dir);
    expect(loaded.map((m) => m.id)).toEqual(['0001_a', '0002_b']);
    expect(loaded[1]?.checksum).toBe(sha(source));
    expect(loaded[1]?.statements).toEqual(['CREATE B']);
  });

  it('ignores files that are not .cypher', () => {
    const dir = dirWith({ '0001_a.cypher': 'CREATE A;', 'README.md': '# notes', 'x.txt': 'nope' });
    expect(loadGraphMigrations(dir).map((m) => m.id)).toEqual(['0001_a']);
  });

  it.each(['a.cypher', '01_a.cypher', '0001-a.cypher', '0001_A.cypher'])(
    'rejects the file name %s (fail closed)',
    (name) => {
      const dir = dirWith({ [name]: 'CREATE A;' });
      expect(() => loadGraphMigrations(dir)).toThrow(AppError);
      expect(() => loadGraphMigrations(dir)).toThrow(/NNNN_name\.cypher/);
    },
  );

  it('rejects two files that share a sequence number', () => {
    const dir = dirWith({ '0001_a.cypher': 'CREATE A;', '0001_b.cypher': 'CREATE B;' });
    expect(() => loadGraphMigrations(dir)).toThrow(/unique NNNN/);
  });

  it('rejects a file that has no statements', () => {
    const dir = dirWith({ '0001_a.cypher': '// only a comment\n' });
    expect(() => loadGraphMigrations(dir)).toThrow(/has no statements/);
  });

  it('loads the committed 0001 migration with every surface key and index', () => {
    const [first, second, third, ...rest] = loadGraphMigrations(GRAPH_MIGRATIONS_DIR);
    expect(first?.id).toBe('0001_surface_constraints');
    // 0002 is the Run and Observation sub-model (GRAPH-007); its own statements are checked in its own test.
    expect(second?.id).toBe('0002_run_observation_constraints');
    // 0003 is the spec-ingestion labels (INGEST-001), checked in the integration test that writes them.
    expect(third?.id).toBe('0003_spec_ingestion_constraints');
    expect(rest).toEqual([]);
    const text = first?.statements.join('\n') ?? '';
    const keys: Record<string, string> = {
      Asset: '(n.tenantId, n.assetId)',
      Host: '(n.tenantId, n.hostname)',
      Service: '(n.tenantId, n.hostname, n.port, n.protocol)',
      Technology: '(n.tenantId, n.cpe)',
      Endpoint: '(n.tenantId, n.assetId, n.method, n.pathTemplate)',
      Parameter: '(n.tenantId, n.endpointKey, n.name, n.location)',
      Role: '(n.tenantId, n.assetId, n.roleName)',
    };
    for (const [label, key] of Object.entries(keys)) {
      expect(text).toContain(`FOR (n:${label}) REQUIRE ${key} IS UNIQUE`);
      expect(text).toContain(`FOR (n:${label}) ON (n.tenantId)`);
    }
    expect(text).toContain('FOR (n:Endpoint) ON (n.assetId)');
    expect(text).toContain('FOR (n:Service) ON (n.port)');
    expect(text).toContain('FOR (n:Technology) ON (n.name)');
  });

  it('makes every statement of the committed migration idempotent', () => {
    const [first] = loadGraphMigrations(GRAPH_MIGRATIONS_DIR);
    for (const statement of first?.statements ?? []) {
      expect(statement).toMatch(/^CREATE (CONSTRAINT|INDEX) \w+ IF NOT EXISTS FOR \(n:\w+\)/);
    }
  });
});

describe('compareGraphMigrations', () => {
  it('reports pending files when the ledger is empty', () => {
    expect(compareGraphMigrations([M1, M2], [])).toEqual({
      applied: [],
      pending: ['0001_first', '0002_second'],
      partial: [],
      drifted: [],
      missing: [],
    });
  });

  it('reports applied, partial and pending migrations', () => {
    const report = compareGraphMigrations(
      [M1, M2, migration('0003_third', ['CREATE E'])],
      [
        { id: '0001_first', checksum: M1.checksum, status: 'applied', statementsApplied: 3 },
        { id: '0002_second', checksum: M2.checksum, status: 'in_progress', statementsApplied: 0 },
      ],
    );
    expect(report).toEqual({
      applied: ['0001_first'],
      pending: ['0003_third'],
      partial: ['0002_second'],
      drifted: [],
      missing: [],
    });
  });

  it('reports a changed checksum as drift, even for an applied migration', () => {
    const report = compareGraphMigrations(
      [M1],
      [{ id: '0001_first', checksum: 'f'.repeat(64), status: 'applied', statementsApplied: 3 }],
    );
    expect(report.drifted).toEqual(['0001_first']);
    expect(report.applied).toEqual([]);
  });

  it('reports a ledger entry with no file as missing', () => {
    const report = compareGraphMigrations(
      [M1],
      [{ id: '0009_gone', checksum: 'x', status: 'applied', statementsApplied: 1 }],
    );
    expect(report.missing).toEqual(['0009_gone']);
  });

  it('reports a file added before an already-applied one as drift (out of sequence)', () => {
    const report = compareGraphMigrations(
      [M1, M2],
      [{ id: '0002_second', checksum: M2.checksum, status: 'applied', statementsApplied: 1 }],
    );
    expect(report.pending).toEqual(['0001_first']);
    expect(report.drifted).toEqual(['0002_second']);
  });
});

describe('isGraphMigrationReportClean', () => {
  it.each([
    ['pending', { pending: ['x'] }],
    ['partial', { partial: ['x'] }],
    ['drifted', { drifted: ['x'] }],
    ['missing', { missing: ['x'] }],
  ])('is false when anything is %s', (_name, overrides) => {
    expect(
      isGraphMigrationReportClean({
        applied: [],
        pending: [],
        partial: [],
        drifted: [],
        missing: [],
        ...overrides,
      }),
    ).toBe(false);
  });

  it('is true when everything is applied', () => {
    expect(
      isGraphMigrationReportClean({
        applied: ['0001_first'],
        pending: [],
        partial: [],
        drifted: [],
        missing: [],
      }),
    ).toBe(true);
  });
});

describe('applyGraphMigrations', () => {
  it('applies every pending migration in order, one statement per call, and records progress', async () => {
    const fake = fakeStore();
    const metrics = { migrationApplied: vi.fn() };
    const applied = await applyGraphMigrations(fake.store, [M1, M2], deps(fakeLogger(), metrics));

    expect(applied).toEqual(['0001_first', '0002_second']);
    expect(work(fake)).toEqual(['CREATE A', 'CREATE B', 'CREATE C', 'CREATE D']);
    expect(fake.ledger.get('0001_first')).toEqual({
      id: '0001_first',
      checksum: M1.checksum,
      status: 'applied',
      statementsApplied: 3,
    });
    expect(fake.ledger.get('0002_second')?.status).toBe('applied');
    expect(metrics.migrationApplied).toHaveBeenCalledTimes(2);
  });

  it('runs the bootstrap constraints before taking the lock', async () => {
    const fake = fakeStore();
    await applyGraphMigrations(fake.store, [M1], deps());
    const firstLock = fake.calls.indexOf('acquireLock');
    expect(fake.calls.slice(0, BOOTSTRAP_COUNT)).toEqual(['execute', 'execute']);
    expect(firstLock).toBe(BOOTSTRAP_COUNT);
  });

  it('is a no-op on a second run, and applies nothing it already applied', async () => {
    const fake = fakeStore();
    await applyGraphMigrations(fake.store, [M1, M2], deps());
    fake.executed.length = 0;
    const applied = await applyGraphMigrations(fake.store, [M1, M2], deps());
    expect(applied).toEqual([]);
    expect(work(fake)).toEqual([]);
  });

  it('logs each applied migration with its id, checksum and duration', async () => {
    const logger = fakeLogger();
    await applyGraphMigrations(fakeStore().store, [M2], deps(logger));
    const applied = logger.lines.find((line) => line.event === 'graph.migration.applied');
    expect(applied).toMatchObject({
      level: 'info',
      fields: { id: '0002_second', checksum: M2.checksum, durationMs: 0 },
    });
  });

  it('fails with GRAPH_MIGRATION_DRIFT before applying anything when a checksum changed', async () => {
    const fake = fakeStore({
      ledger: [{ id: '0001_first', checksum: 'changed', status: 'applied', statementsApplied: 3 }],
    });
    const error = await applyGraphMigrations(fake.store, [M1, M2], deps()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_MIGRATION_DRIFT');
    expect(work(fake)).toEqual([]);
    expect(fake.lock()).toBeUndefined();
  });

  it('fails with GRAPH_MIGRATION_DRIFT when the ledger names a file that no longer exists', async () => {
    const fake = fakeStore({
      ledger: [{ id: '0009_gone', checksum: 'x', status: 'applied', statementsApplied: 1 }],
    });
    const error = await applyGraphMigrations(fake.store, [M1], deps()).catch(
      (caught: unknown) => caught,
    );
    expect((error as AppError).code).toBe('GRAPH_MIGRATION_DRIFT');
    expect(work(fake)).toEqual([]);
  });

  it('resumes a half-applied migration from the statement after the last recorded one', async () => {
    const fake = fakeStore({
      ledger: [
        { id: '0001_first', checksum: M1.checksum, status: 'in_progress', statementsApplied: 2 },
      ],
    });
    const logger = fakeLogger();
    await applyGraphMigrations(fake.store, [M1], deps(logger));
    expect(work(fake)).toEqual(['CREATE C']);
    expect(fake.ledger.get('0001_first')?.status).toBe('applied');
    const resumed = logger.lines.find((line) => line.event === 'graph.migration.resumed');
    expect(resumed).toMatchObject({
      level: 'warn',
      fields: { id: '0001_first', resume_from_statement: 2 },
    });
  });

  it('records progress as each statement finishes, so a failure leaves an accurate ledger', async () => {
    const fake = fakeStore({ failOn: 'CREATE B' });
    const logger = fakeLogger();
    await expect(applyGraphMigrations(fake.store, [M1], deps(logger))).rejects.toThrow();
    expect(fake.ledger.get('0001_first')).toEqual({
      id: '0001_first',
      checksum: M1.checksum,
      status: 'in_progress',
      statementsApplied: 1,
    });
    expect(fake.lock()).toBeUndefined();
    const failed = logger.lines.find((line) => line.event === 'graph.migration.failed');
    expect(failed).toMatchObject({
      level: 'error',
      fields: { id: '0001_first', statement_index: 1 },
    });
  });

  it('never logs the error message of a failed statement (it can name hosts)', async () => {
    const logger = fakeLogger();
    await expect(
      applyGraphMigrations(fakeStore({ failOn: 'CREATE A' }).store, [M1], deps(logger)),
    ).rejects.toThrow();
    expect(JSON.stringify(logger.lines)).not.toContain('graph.internal');
  });

  it('completes the resume of a migration whose statements all ran before a crash', async () => {
    const fake = fakeStore({
      ledger: [
        { id: '0001_first', checksum: M1.checksum, status: 'in_progress', statementsApplied: 3 },
      ],
    });
    await applyGraphMigrations(fake.store, [M1], deps());
    expect(work(fake)).toEqual([]);
    expect(fake.ledger.get('0001_first')?.status).toBe('applied');
  });

  it('refuses to run while another run holds a live lock, and does not release that lock', async () => {
    const fake = fakeStore({ lockHeldBy: { owner: 'other-pod', expiresAtMs: NOW + 1000 } });
    const error = await applyGraphMigrations(fake.store, [M1], deps()).catch(
      (caught: unknown) => caught,
    );
    expect((error as AppError).code).toBe('GRAPH_MIGRATION_LOCKED');
    expect(work(fake)).toEqual([]);
    expect(fake.lock()).toEqual({ owner: 'other-pod', expiresAtMs: NOW + 1000 });
  });

  it('takes over a lock whose lease has expired', async () => {
    const fake = fakeStore({ lockHeldBy: { owner: 'dead-pod', expiresAtMs: NOW - 1 } });
    await applyGraphMigrations(fake.store, [M1], deps());
    expect(fake.ledger.get('0001_first')?.status).toBe('applied');
    expect(fake.lock()).toBeUndefined();
  });

  it('releases the lock when the run fails', async () => {
    const fake = fakeStore({ failOn: 'CREATE A' });
    await expect(applyGraphMigrations(fake.store, [M1], deps())).rejects.toThrow();
    expect(fake.lock()).toBeUndefined();
  });

  it('reports the metric once per migration applied in this run', async () => {
    const metrics = { migrationApplied: vi.fn() };
    const fake = fakeStore({
      ledger: [
        { id: '0001_first', checksum: M1.checksum, status: 'applied', statementsApplied: 3 },
      ],
    });
    await applyGraphMigrations(fake.store, [M1, M2], deps(fakeLogger(), metrics));
    expect(metrics.migrationApplied).toHaveBeenCalledTimes(1);
  });
});

describe('checkGraphMigrationsOn', () => {
  it('reports pending migrations and never writes, takes a lock or runs a statement', async () => {
    const fake = fakeStore();
    const report = await checkGraphMigrationsOn(fake.store, [M1, M2]);
    expect(report.pending).toEqual(['0001_first', '0002_second']);
    expect(fake.calls).toEqual(['readLedger']);
    expect(fake.executed).toEqual([]);
    expect(fake.ledger.size).toBe(0);
  });

  it('reports partial and drifted migrations without repairing them', async () => {
    const fake = fakeStore({
      ledger: [
        { id: '0001_first', checksum: 'old', status: 'applied', statementsApplied: 3 },
        { id: '0002_second', checksum: M2.checksum, status: 'in_progress', statementsApplied: 0 },
      ],
    });
    const report = await checkGraphMigrationsOn(fake.store, [M1, M2]);
    expect(report.drifted).toEqual(['0001_first']);
    expect(report.partial).toEqual(['0002_second']);
    expect(fake.calls).toEqual(['readLedger']);
  });
});
