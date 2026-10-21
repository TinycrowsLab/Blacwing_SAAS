// emitAudit against real Postgres (AUDIT-003): transactional append, rollback, relay idempotency,
// redaction at rest, tenant fail-closed and concurrent sequencing. Needs Docker (Testcontainers);
// run with `pnpm --filter @blackwing/audit test:int`.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_GENESIS_PREV_HASH,
  auditEventHashInput,
  type AuditEvent,
} from '@blackwing/contracts';
import { migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { appendAuditOutboxPayload, createAuditEmitter } from './emit.js';
import { MemoryOutbox } from './test-support.js';

import type { AuditEventInput } from './draft.js';
import type { AppError } from '@blackwing/errors';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const SECRET = 'int-test-secret-value-0451';

const emitter = () =>
  createAuditEmitter({ redact: (text) => text.replaceAll(SECRET, '[REDACTED]') });

function input(tenantId: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    tenantId,
    action: 'gate2.decided',
    actor: { type: 'user', id: 'user-1' },
    target: { type: 'run', id: 'run-1' },
    outcome: 'denied',
    metadata: { decision: 'deny' },
    ...overrides,
  };
}

interface Stored {
  id: string;
  seq: string;
  occurred_at: Date;
  action: string;
  severity: AuditEvent['severity'];
  actor: AuditEvent['actor'];
  target: AuditEvent['target'];
  outcome: AuditEvent['outcome'];
  reason: string | null;
  metadata: AuditEvent['metadata'];
  prev_hash: Buffer | null;
  hash: Buffer;
}

/** Reads a tenant's chain and recomputes every hash; returns the sequence numbers. */
async function verifyChain(tenantId: string): Promise<number[]> {
  const rows = await db.withTenant(
    tenantId,
    async (tx) => (await tx.query<Stored>('SELECT * FROM audit_events ORDER BY seq')).rows,
  );
  let previous = AUDIT_GENESIS_PREV_HASH;
  for (const row of rows) {
    expect(row.prev_hash === null ? AUDIT_GENESIS_PREV_HASH : row.prev_hash.toString('hex')).toBe(
      previous,
    );
    const hashInput = auditEventHashInput({
      id: row.id,
      tenantId,
      occurredAt: row.occurred_at.toISOString(),
      action: row.action,
      severity: row.severity,
      actor: row.actor,
      target: row.target,
      outcome: row.outcome,
      ...(row.reason === null ? {} : { reason: row.reason }),
      metadata: row.metadata,
      prevHash: previous,
      seq: Number(row.seq),
    } as AuditEvent);
    const expected = createHash('sha256').update(hashInput, 'utf8').digest('hex');
    expect(row.hash.toString('hex')).toBe(expected);
    previous = expected;
  }
  return rows.map((row) => Number(row.seq));
}

const count = (tenantId: string) =>
  db.withTenant(tenantId, async (tx) =>
    Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM audit_events')).rows[0]?.n),
  );

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
});

afterAll(async () => {
  await db.stop();
});

describe('emitAuditInTx', () => {
  it('appends correctly chained rows committed with the caller transaction', async () => {
    for (let i = 0; i < 3; i += 1) {
      await db.withTenant(tenantA, (tx) =>
        emitter().emitAuditInTx(tx, input(tenantA, { metadata: { i } })),
      );
    }
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('rolls back with the caller transaction (nothing is left behind)', async () => {
    const before = await count(tenantA);
    await expect(
      db.withTenant(tenantA, async (tx) => {
        await emitter().emitAuditInTx(tx, input(tenantA));
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');
    expect(await count(tenantA)).toBe(before);
    expect(await verifyChain(tenantA)).toEqual([1, 2, 3]);
  });

  it('is a no-op for a repeated dedupeKey', async () => {
    const emit = () =>
      db.withTenant(tenantB, (tx) =>
        emitter().emitAuditInTx(tx, input(tenantB, { dedupeKey: 'once' })),
      );
    expect(await emit()).toBeDefined();
    expect(await emit()).toBeUndefined();
    expect(await count(tenantB)).toBe(1);
  });

  it('removes a seeded secret from metadata and reason at rest', async () => {
    await db.withTenant(tenantB, (tx) =>
      emitter().emitAuditInTx(
        tx,
        input(tenantB, { reason: `used ${SECRET}`, metadata: { note: SECRET, password: 'p4ss' } }),
      ),
    );
    const rows = await db.withTenant(
      tenantB,
      async (tx) => (await tx.query<Stored>('SELECT * FROM audit_events')).rows,
    );
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('p4ss');
    expect(await verifyChain(tenantB)).toEqual([1, 2]);
  });

  it('serialises concurrent writers of one tenant without forks or gaps', async () => {
    const before = await count(tenantA);
    await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        db.withTenant(tenantA, (tx) =>
          emitter().emitAuditInTx(tx, input(tenantA, { metadata: { c: i } })),
        ),
      ),
    );
    expect(await verifyChain(tenantA)).toEqual(
      Array.from({ length: before + 8 }, (_unused, i) => i + 1),
    );
  });

  it('fails closed without tenant context and for a foreign tenant', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query('BEGIN');
      const error = await emitter()
        .emitAuditInTx(client, input(tenantA))
        .catch((e: unknown) => e);
      expect((error as AppError).code).toBe('TENANT_CONTEXT_MISSING');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const foreign = await db
      .withTenant(tenantA, (tx) => emitter().emitAuditInTx(tx, input(tenantB)))
      .catch((e: unknown) => e);
    expect((foreign as AppError).code).toBe('FORBIDDEN');
  });
});

describe('emitAudit through the outbox and the relay append', () => {
  it('writes exactly one chain row even if the relay retries', async () => {
    const outbox = new MemoryOutbox();
    const before = await count(tenantA);
    await createAuditEmitter({ outbox }).emitAudit(input(tenantA, { dedupeKey: 'relay-1' }));
    const [message] = outbox.messages;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.withTenant(tenantA, (tx) => appendAuditOutboxPayload(tx, message?.payload));
    }
    expect(await count(tenantA)).toBe(before + 1);
    expect(await verifyChain(tenantA)).toHaveLength(before + 1);
  });
});
