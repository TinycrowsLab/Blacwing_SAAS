// Audit query API against real Postgres (#86): filters, keyset pagination with ties, RLS isolation and
// the audit.queried record joining the ledger chain. Needs Docker (Testcontainers); run with
// `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuditEmitter, type AuditEventInput } from '@blackwing/audit';
import { createDatabase, migrateDatabase, toAuditSqlTx, withTenant } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { principal } from './fixtures.test-helpers.js';
import { createAuditQueryMetrics } from './metrics.js';
import { createPgAuditQueryStore } from './postgres.js';
import { AuditQueryService } from './service.js';
import { createCursorCodec } from '../pagination/cursor.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const SECRET = 'int-query-cursor-secret-0123456789';
const emitter = createAuditEmitter();

function event(tenantId: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    tenantId,
    action: 'kill.fired',
    actor: { type: 'user', id: 'usr_alice' },
    target: { type: 'run', id: '01890a5d-ac96-774b-bcce-b302099a8058' },
    outcome: 'success',
    metadata: { scope: 'run' },
    occurredAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

async function seed(tenantId: string, inputs: readonly AuditEventInput[]): Promise<void> {
  const orm = createDatabase(db.appPool);
  for (const input of inputs) {
    await withTenant(orm, tenantId, (tx) => emitter.emitAuditInTx(toAuditSqlTx(tx), input));
  }
}

function serviceFor(): AuditQueryService {
  return new AuditQueryService({
    store: createPgAuditQueryStore(createDatabase(db.appPool), emitter),
    codec: createCursorCodec(SECRET),
    metrics: { registry: createAuditQueryMetrics().registry, record: () => undefined },
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  // 12 events share one timestamp (the tie case), 3 are later, all in tenant A; one is in tenant B.
  await seed(tenantA, [
    ...Array.from({ length: 12 }, () => event(tenantA)),
    ...Array.from({ length: 3 }, (_v, i) =>
      event(tenantA, { occurredAt: `2026-10-21T00:00:0${i}.000Z`, action: 'kill.completed' }),
    ),
  ]);
  await seed(tenantB, [event(tenantB, { target: { type: 'run', id: 'tenant-b-target' } })]);
});

afterAll(async () => {
  await db.stop();
});

describe('audit query over Postgres', () => {
  it('pages through every row exactly once, through timestamp ties (keyset on occurred_at, seq)', async () => {
    const service = serviceFor();
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(principal(['auditor'], { tenantId: tenantA }), {
        limit: '4',
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.seq));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('applies filters in SQL: action and a from bound', async () => {
    const service = serviceFor();
    const page = await service.list(principal(['auditor'], { tenantId: tenantA }), {
      action: 'kill.completed',
      from: '2026-10-20T12:00:00Z',
    });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((item) => item.action === 'kill.completed')).toBe(true);
  });

  it('never returns another tenant rows, even for an id that exists there (RLS)', async () => {
    const service = serviceFor();
    const page = await service.list(principal(['auditor'], { tenantId: tenantA }), {
      targetId: 'tenant-b-target',
    });
    expect(page.items).toEqual([]);
  });

  it('writes an audit.queried row into the tenant chain for every query', async () => {
    const service = serviceFor();
    const before = await db.withTenant(tenantA, async (tx) =>
      Number(
        (
          await tx.query<{ n: string }>(
            "SELECT count(*) AS n FROM audit_events WHERE action = 'audit.queried'",
          )
        ).rows[0]?.n,
      ),
    );
    await service.list(principal(['auditor'], { tenantId: tenantA }), { limit: '1' });
    const after = await db.withTenant(tenantA, async (tx) =>
      Number(
        (
          await tx.query<{ n: string }>(
            "SELECT count(*) AS n FROM audit_events WHERE action = 'audit.queried'",
          )
        ).rows[0]?.n,
      ),
    );
    expect(after).toBe(before + 1);
  });

  it('refuses a caller with audit:read but no tenant of their own, before touching the ledger', async () => {
    const service = serviceFor();
    await expect(
      service.list(principal(['auditor'], { tenantId: null }), {}),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
  });
});
