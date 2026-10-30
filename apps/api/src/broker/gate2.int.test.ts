// The Gate 2 broker store against the real migrations on Postgres (Testcontainers, GATE2-002): the exception and
// the run pause commit together, a replay is a no-op, a run that cannot pause rolls the exception back, and another
// tenant's run is invisible. Needs Docker; run with `pnpm --filter @blackwing/api test:int`.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase, runs, withTenant } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPostgresGate2Store } from './gate2.js';

import type { Gate2ExceptionCreate } from '@blackwing/contracts';

let pg: PostgresHandle;
let database: Database;
let tenantA = newId();
let tenantB = newId();
let runId = newId();

const future = (): string => new Date(Date.now() + 30 * 60_000).toISOString();

function create(overrides: Partial<Gate2ExceptionCreate> = {}): Gate2ExceptionCreate {
  return {
    runId,
    sessionId: 'session-1',
    toolName: 'nmap.scan',
    proposedAction: { summary: '{"target":"10.0.0.9"}', truncated: false },
    envelopeReason: 'target outside the approved envelope',
    intrusiveness: 'active_safe',
    batch: false,
    timeoutAt: future(),
    idempotencyKey: `key-${newId()}`,
    ...overrides,
  };
}

async function seedRun(tenantId: string, id: string, state: 'executing' | 'killed'): Promise<void> {
  await withTenant(database, tenantId, (tx) =>
    tx.insert(runs).values({ id, tenantId, state, stateVersion: 0 }),
  );
}

async function runRow(tenantId: string, id: string) {
  return withTenant(database, tenantId, async (tx) => {
    const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row;
  });
}

async function exceptionCount(tenantId: string): Promise<number> {
  const client = await pg.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM gate2_exceptions WHERE tenant_id = $1',
      [tenantId],
    );
    await client.query('COMMIT');
    return Number(result.rows[0]?.n ?? 0);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function auditCount(tenantId: string, action: string): Promise<number> {
  const client = await pg.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    );
    await client.query('COMMIT');
    return Number(result.rows[0]?.n ?? 0);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(() => {
  tenantA = newId();
  tenantB = newId();
  runId = newId();
});

beforeAll(async () => {
  pg = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pg.appPool);
});

afterAll(async () => {
  await pg.stop();
});

describe('createPostgresGate2Store', () => {
  it('creates a pending exception and pauses the run as gate2_pending in one transaction', async () => {
    await seedRun(tenantA, runId, 'executing');
    const store = createPostgresGate2Store(database);
    const result = await store.raise({ tenantId: tenantA, runId }, create());
    expect(result.created).toBe(true);
    expect(result.exception.state).toBe('pending');
    expect(result.exception.proposedAction).toEqual({
      summary: '{"target":"10.0.0.9"}',
      truncated: false,
    });

    const row = await runRow(tenantA, runId);
    expect(row).toMatchObject({
      state: 'paused',
      pauseReason: 'gate2_pending',
      resumeTo: 'executing',
      stateVersion: 1,
    });
    expect(await auditCount(tenantA, 'gate2.exception.created')).toBe(1);
    expect(await auditCount(tenantA, 'run.state_changed')).toBe(1);
  });

  it('a replay with the same key returns the same exception and writes nothing new', async () => {
    await seedRun(tenantA, runId, 'executing');
    const store = createPostgresGate2Store(database);
    const input = create({ idempotencyKey: 'replay-key-1' });
    const first = await store.raise({ tenantId: tenantA, runId }, input);
    const second = await store.raise({ tenantId: tenantA, runId }, input);
    expect(second.created).toBe(false);
    expect(second.exception.id).toBe(first.exception.id);
    expect(await exceptionCount(tenantA)).toBe(1);
    expect(await auditCount(tenantA, 'gate2.exception.created')).toBe(1);
    expect((await runRow(tenantA, runId))?.stateVersion).toBe(1);
  });

  it('rolls the exception back when the run cannot pause (a killed run)', async () => {
    await seedRun(tenantA, runId, 'killed');
    const store = createPostgresGate2Store(database);
    await expect(store.raise({ tenantId: tenantA, runId }, create())).rejects.toThrow();
    expect(await exceptionCount(tenantA)).toBe(0);
    expect(await auditCount(tenantA, 'gate2.exception.created')).toBe(0);
    expect((await runRow(tenantA, runId))?.state).toBe('killed');
  });

  it('the database refuses a paused run without its pause fields (check constraint)', async () => {
    await seedRun(tenantA, runId, 'executing');
    const client = await pg.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await expect(
        client.query("UPDATE runs SET state = 'paused' WHERE id = $1", [runId]),
      ).rejects.toThrow(/runs_pause_fields_check/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('cannot see or pause another tenant run (cross-tenant, fail closed)', async () => {
    await seedRun(tenantB, runId, 'executing');
    const store = createPostgresGate2Store(database);
    await expect(store.raise({ tenantId: tenantA, runId }, create())).rejects.toThrow();
    expect(await exceptionCount(tenantA)).toBe(0);
    expect((await runRow(tenantB, runId))?.state).toBe('executing');
  });
});
