import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuditEventSchema,
  auditEventHashInput,
  AUDIT_GENESIS_PREV_HASH,
} from '@blackwing/contracts';

import { appendToChain, createPgChainStore } from './chain.js';
import { MemoryLedger, RUN_ID, TENANT_A } from './test-support.js';

import type { AuditEventDraft } from './draft.js';
import type { AuditSqlTx } from './ports.js';
import type { AppError } from '@blackwing/errors';

function draft(n: number): AuditEventDraft {
  const event = AuditEventSchema.parse({
    id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    tenantId: TENANT_A,
    occurredAt: '2026-01-01T00:00:00.000Z',
    action: 'run.created',
    severity: 'info',
    actor: { type: 'system' },
    target: { type: 'run', id: RUN_ID },
    outcome: 'success',
    metadata: { n },
    prevHash: AUDIT_GENESIS_PREV_HASH,
    hash: 'a'.repeat(64),
    seq: 1,
  });
  const rest: Partial<typeof event> = { ...event };
  delete rest.prevHash;
  delete rest.hash;
  delete rest.seq;
  return rest as AuditEventDraft;
}

describe('appendToChain', () => {
  it('hashes the JCS form with the head link, genesis first', async () => {
    const ledger = new MemoryLedger();
    const first = await appendToChain(ledger.store(), draft(1));
    const second = await appendToChain(ledger.store(), draft(2));
    expect(first.event?.prevHash).toBe(AUDIT_GENESIS_PREV_HASH);
    expect(ledger.rows[0]?.prevHash).toBeNull();
    expect(second.event?.prevHash).toBe(first.event?.hash);
    const { hash, ...rest } = second.event ?? ({} as never);
    expect(hash).toBe(createHash('sha256').update(auditEventHashInput(rest), 'utf8').digest('hex'));
  });
});

describe('createPgChainStore', () => {
  function recorder(handler: (text: string) => Record<string, unknown>[] = () => []) {
    const calls: { text: string; values: unknown[] | undefined }[] = [];
    const tx: AuditSqlTx = {
      query: (text, values) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: handler(text) });
      },
    };
    return { calls, tx };
  }

  it('takes the lock through bw_audit_chain_head and maps an empty chain to seq 0', async () => {
    const { calls, tx } = recorder(() => [{ head_seq: '0', head_hash: null }]);
    expect(await createPgChainStore(tx).head(TENANT_A)).toEqual({ seq: 0, hash: null });
    expect(calls[0]).toEqual({
      text: 'SELECT head_seq, head_hash FROM bw_audit_chain_head($1)',
      values: [TENANT_A],
    });
  });

  it('reads bigint seq (a string from pg) as a number', async () => {
    const hash = Buffer.alloc(32, 1);
    const { tx } = recorder(() => [{ head_seq: '41', head_hash: hash }]);
    expect(await createPgChainStore(tx).head(TENANT_A)).toEqual({ seq: 41, hash });
  });

  it('inserts every column with bound parameters, bytes for hashes', async () => {
    const { calls, tx } = recorder();
    const store = createPgChainStore(tx);
    await appendToChain(
      {
        head: () => Promise.resolve({ seq: 0, hash: null }),
        exists: () => Promise.resolve(false),
        insert: (row) => store.insert(row),
      },
      draft(1),
    );
    const insert = calls[0];
    expect(insert?.text).toContain('INSERT INTO audit_events');
    expect(insert?.values).toHaveLength(18);
    expect(insert?.values?.[2]).toBe(1);
    expect(insert?.values?.[16]).toBeNull();
    expect(Buffer.isBuffer(insert?.values?.[17])).toBe(true);
    expect(insert?.values?.[6]).toBe('{"type":"system"}');
  });

  it('answers exists from the row count', async () => {
    const yes = recorder(() => [{ found: 1 }]);
    const no = recorder();
    expect(await createPgChainStore(yes.tx).exists(TENANT_A, 'id')).toBe(true);
    expect(await createPgChainStore(no.tx).exists(TENANT_A, 'id')).toBe(false);
  });

  it('maps a missing tenant context and a foreign tenant to AppErrors', async () => {
    const failing = (error: Error): AuditSqlTx => ({
      query: () => Promise.reject(error),
    });
    const missing = await createPgChainStore(
      failing(
        Object.assign(new Error('unrecognized configuration parameter "app.tenant_id"'), {
          code: '42704',
        }),
      ),
    )
      .head(TENANT_A)
      .catch((e: unknown) => e);
    expect((missing as AppError).code).toBe('TENANT_CONTEXT_MISSING');
    const foreign = await createPgChainStore(
      failing(
        Object.assign(
          new Error('audit chain head requested for a tenant other than the session tenant'),
          { code: '42501' },
        ),
      ),
    )
      .head(TENANT_A)
      .catch((e: unknown) => e);
    expect((foreign as AppError).code).toBe('FORBIDDEN');
  });

  it('lets other database errors through unchanged', async () => {
    const boom = new Error('connection terminated');
    const store = createPgChainStore({ query: () => Promise.reject(boom) });
    await expect(store.head(TENANT_A)).rejects.toBe(boom);
  });
});
