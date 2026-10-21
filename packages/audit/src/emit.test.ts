import { describe, expect, it } from 'vitest';

import { AUDIT_METADATA_MAX_BYTES } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { FixedClock } from '@blackwing/time';

import { appendAuditOutboxPayload, createAuditEmitter, toOutboxMessage } from './emit.js';
import { AuditEventInvalidError } from './errors.js';
import {
  MemoryLedger,
  MemoryOutbox,
  NULL_TX,
  RUN_ID,
  SECRET,
  TENANT_A,
  TENANT_B,
  verifyEvents,
} from './test-support.js';

import type { AuditEventInput } from './draft.js';
import type { AuditMetrics } from './ports.js';

const clock = new FixedClock('2026-03-04T05:06:07.890Z');

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    tenantId: TENANT_A,
    action: 'gate2.decided',
    actor: { type: 'user', id: 'user-1', email: 'approver@example.test' },
    target: { type: 'run', id: RUN_ID },
    outcome: 'denied',
    reason: 'timed out; denied by default',
    metadata: { decision: 'deny' },
    runId: RUN_ID,
    ...overrides,
  };
}

function setup() {
  const ledger = new MemoryLedger();
  const outbox = new MemoryOutbox();
  const calls: string[] = [];
  const metrics: AuditMetrics = {
    emitted: ({ action, path }) => calls.push(`ok:${action}:${path}`),
    failed: ({ path }) => calls.push(`fail:${path}`),
  };
  const spans: string[] = [];
  const emitter = createAuditEmitter({
    outbox,
    clock,
    metrics,
    span: (name, fn) => {
      spans.push(name);
      return fn();
    },
    chainStore: () => ledger.store(),
    redact: (text) => text.replaceAll(SECRET, '[REDACTED]'),
  });
  return { ledger, outbox, calls, spans, emitter };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-an-app-error';
  }
  return undefined;
}

describe('emitAuditInTx', () => {
  it('appends correctly chained rows (gapless seq, hash covers prevHash)', async () => {
    const { ledger, emitter, calls, spans } = setup();
    for (let i = 0; i < 3; i += 1) await emitter.emitAuditInTx(NULL_TX, input({ metadata: { i } }));
    await emitter.emitAuditInTx(NULL_TX, input({ tenantId: TENANT_B }));
    expect(verifyEvents(ledger.forTenant(TENANT_A))).toEqual([1, 2, 3]);
    expect(verifyEvents(ledger.forTenant(TENANT_B))).toEqual([1]);
    expect(calls).toContain('ok:gate2.decided:sync');
    expect(spans).toEqual(new Array<string>(4).fill('audit.emit'));
  });

  it('fills id, occurredAt and the catalogue severity', async () => {
    const { emitter } = setup();
    const event = await emitter.emitAuditInTx(NULL_TX, input());
    expect(event?.occurredAt).toBe('2026-03-04T05:06:07.890Z');
    expect(event?.severity).toBe('notice');
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is a no-op for a repeated dedupeKey', async () => {
    const { ledger, emitter } = setup();
    const first = await emitter.emitAuditInTx(NULL_TX, input({ dedupeKey: 'gate-1:run-1' }));
    const second = await emitter.emitAuditInTx(NULL_TX, input({ dedupeKey: 'gate-1:run-1' }));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(ledger.rows).toHaveLength(1);
    await emitter.emitAuditInTx(NULL_TX, input({ dedupeKey: 'gate-1:run-2' }));
    expect(verifyEvents(ledger.forTenant(TENANT_A))).toEqual([1, 2]);
  });

  it('rejects when the append fails, so the caller transaction rolls back', async () => {
    const { calls } = setup();
    const emitter = createAuditEmitter({
      clock,
      metrics: { emitted: () => undefined, failed: ({ path }) => calls.push(`fail:${path}`) },
      chainStore: () => ({
        head: () => Promise.reject(new Error('connection refused')),
        exists: () => Promise.resolve(false),
        insert: () => Promise.resolve(),
      }),
    });
    await expect(emitter.emitAuditInTx(NULL_TX, input())).rejects.toThrow('connection refused');
    expect(calls).toEqual(['fail:sync']);
  });
});

describe('emitAudit (outbox)', () => {
  it('enqueues one audit.event row and writes nothing to the chain', async () => {
    const { ledger, outbox, emitter, calls } = setup();
    await emitter.emitAudit(input());
    expect(ledger.rows).toHaveLength(0);
    expect(outbox.messages).toHaveLength(1);
    const [message] = outbox.messages;
    expect(message).toMatchObject({
      tenantId: TENANT_A,
      type: 'audit.event',
      aggregateType: 'run',
      aggregateId: RUN_ID,
    });
    expect(message?.dedupeKey).toBe((message?.payload as { id: string }).id);
    expect(calls).toEqual(['ok:gate2.decided:outbox']);
  });

  it('joins the caller transaction when one is given', async () => {
    const { outbox, emitter } = setup();
    await emitter.emitAudit(input(), { tx: NULL_TX });
    expect(outbox.txs).toEqual([NULL_TX]);
  });

  it('writes exactly one chain row even if the relay retries', async () => {
    const { ledger, outbox, emitter } = setup();
    await emitter.emitAudit(input());
    await emitter.emitAudit(input({ tenantId: TENANT_A, metadata: { other: true } }));
    const deps = { chainStore: () => ledger.store() };
    for (const message of outbox.messages) {
      await appendAuditOutboxPayload(NULL_TX, message.payload, deps);
    }
    // Relay crashed after the append, before marking the rows dispatched: redelivery.
    for (const message of outbox.messages) {
      expect(await appendAuditOutboxPayload(NULL_TX, message.payload, deps)).toBeUndefined();
    }
    expect(verifyEvents(ledger.forTenant(TENANT_A))).toEqual([1, 2]);
  });

  it('dedupes a retried producer at the outbox and at append', async () => {
    const { ledger, outbox, emitter } = setup();
    await emitter.emitAudit(input({ dedupeKey: 'k' }));
    await emitter.emitAudit(input({ dedupeKey: 'k' }));
    expect(outbox.messages).toHaveLength(1);
    for (const message of [...outbox.messages, ...outbox.messages]) {
      await appendAuditOutboxPayload(NULL_TX, message.payload, {
        chainStore: () => ledger.store(),
      });
    }
    expect(ledger.rows).toHaveLength(1);
  });

  it('chains identically to the synchronous path', async () => {
    const sync = setup();
    const async = setup();
    await sync.emitter.emitAuditInTx(NULL_TX, input({ dedupeKey: 'same' }));
    await async.emitter.emitAudit(input({ dedupeKey: 'same' }));
    await appendAuditOutboxPayload(NULL_TX, async.outbox.messages[0]?.payload, {
      chainStore: () => async.ledger.store(),
    });
    expect(async.ledger.rows[0]?.event).toEqual(sync.ledger.rows[0]?.event);
  });

  it('rejects, leaving nothing behind, when the outbox write fails', async () => {
    const { outbox, emitter, calls } = setup();
    outbox.failWith = new Error('outbox down');
    await expect(emitter.emitAudit(input())).rejects.toThrow('outbox down');
    expect(calls).toEqual(['fail:outbox']);
  });

  it('refuses to run without an outbox', async () => {
    const emitter = createAuditEmitter({ clock });
    await expect(emitter.emitAudit(input())).rejects.toThrow(/no outbox/);
  });

  it('refuses a tampered outbox payload at relay time', async () => {
    const { ledger, outbox, emitter } = setup();
    await emitter.emitAudit(input());
    const payload = { ...(outbox.messages[0]?.payload as object), action: 'made.up' };
    const code = await codeOf(
      appendAuditOutboxPayload(NULL_TX, payload, { chainStore: () => ledger.store() }),
    );
    expect(code).toBe('AUDIT_EVENT_INVALID');
    expect(ledger.rows).toHaveLength(0);
    expect(await codeOf(appendAuditOutboxPayload(NULL_TX, 'nope'))).toBe('AUDIT_EVENT_INVALID');
  });
});

describe('redaction', () => {
  it('removes a seeded secret value from metadata and reason before persistence', async () => {
    const { ledger, outbox, emitter } = setup();
    const event = input({
      reason: `approval used ${SECRET}`,
      metadata: {
        note: `curl -H "Authorization: Bearer abcdefgh12345678" with ${SECRET}`,
        nested: { list: [`x ${SECRET} y`, 'bwk_live_abcdef123456'] },
        [`key ${SECRET}`]: 1,
        password: 'plain',
        apiKey: { value: 'nested secret' },
        tokenId: 'tok_123',
        aws: 'AKIAABCDEFGHIJKLMNOP',
        gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    });
    await emitter.emitAuditInTx(NULL_TX, event);
    await emitter.emitAudit(event);
    const stored = JSON.stringify([ledger.rows, outbox.messages]);
    for (const leaked of [
      SECRET,
      'abcdefgh12345678',
      'bwk_live_abcdef123456',
      'plain',
      'nested secret',
      'AKIAABCDEFGHIJKLMNOP',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ]) {
      expect(stored).not.toContain(leaked);
    }
    expect(stored).toContain('[REDACTED]');
    expect(stored).toContain('tok_123');
  });

  it('fails closed when the registry redactor throws', async () => {
    const ledger = new MemoryLedger();
    const emitter = createAuditEmitter({
      clock,
      chainStore: () => ledger.store(),
      redact: () => {
        throw new Error('registry down');
      },
    });
    await emitter.emitAuditInTx(NULL_TX, input({ reason: 'sensitive text', metadata: { a: 'b' } }));
    const stored = JSON.stringify(ledger.rows[0]?.event);
    expect(stored).not.toContain('sensitive text');
    expect(stored).toContain('[REDACTED]');
  });

  it('never echoes input values in the error for an invalid event', async () => {
    const { emitter } = setup();
    const error = await emitter
      .emitAuditInTx(NULL_TX, input({ outcome: SECRET as never, reason: SECRET }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuditEventInvalidError);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe('validation', () => {
  it.each([
    ['unknown action', { action: 'nope.nothing' as never }],
    ['missing target', { target: undefined as never }],
    ['unknown outcome', { outcome: 'maybe' as never }],
    ['lowered severity', { severity: 'info' as const, action: 'kill.fired' as const }],
    ['bad dedupeKey', { dedupeKey: 'has space' }],
    ['bad occurredAt', { occurredAt: 'yesterday' }],
    ['non-JSON metadata', { metadata: { f: 1n } as never }],
    ['__proto__ key', { metadata: JSON.parse('{"__proto__":1}') as never }],
    [
      'oversized metadata without a spill',
      { metadata: { big: 'x'.repeat(AUDIT_METADATA_MAX_BYTES) } },
    ],
  ])('throws AUDIT_EVENT_INVALID for %s (both paths)', async (_name, overrides) => {
    const { ledger, outbox, emitter } = setup();
    expect(await codeOf(emitter.emitAuditInTx(NULL_TX, input(overrides)))).toBe(
      'AUDIT_EVENT_INVALID',
    );
    expect(await codeOf(emitter.emitAudit(input(overrides)))).toBe('AUDIT_EVENT_INVALID');
    expect(ledger.rows).toHaveLength(0);
    expect(outbox.messages).toHaveLength(0);
  });

  it('rejects over-deep or cyclic metadata instead of recursing forever', async () => {
    const { emitter } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await codeOf(emitter.emitAuditInTx(NULL_TX, input({ metadata: cyclic as never })))).toBe(
      'AUDIT_EVENT_INVALID',
    );
  });

  it('fails closed without a tenant', async () => {
    const { ledger, outbox, emitter } = setup();
    for (const tenantId of ['', undefined as never, 42 as never]) {
      expect(await codeOf(emitter.emitAuditInTx(NULL_TX, input({ tenantId })))).toBe(
        'TENANT_CONTEXT_MISSING',
      );
      expect(await codeOf(emitter.emitAudit(input({ tenantId })))).toBe('TENANT_CONTEXT_MISSING');
    }
    expect(await codeOf(emitter.emitAuditInTx(NULL_TX, input({ tenantId: 'not-a-uuid' })))).toBe(
      'AUDIT_EVENT_INVALID',
    );
    expect(ledger.rows).toHaveLength(0);
    expect(outbox.messages).toHaveLength(0);
  });
});

describe('large metadata', () => {
  it('stores a reference and keeps the event small', async () => {
    const ledger = new MemoryLedger();
    const spilled: { key: string; sizeBytes: number; sha256: string }[] = [];
    const emitter = createAuditEmitter({
      clock,
      chainStore: () => ledger.store(),
      redact: (text) => text.replaceAll(SECRET, '[REDACTED]'),
      spillMetadata: ({ metadata, sizeBytes, sha256 }) => {
        spilled.push({ key: 'ev/1', sizeBytes, sha256 });
        expect(JSON.stringify(metadata)).not.toContain(SECRET);
        return Promise.resolve('tenant/ev/1');
      },
    });
    const big = { blob: `${SECRET}${'x'.repeat(AUDIT_METADATA_MAX_BYTES)}` };
    const event = await emitter.emitAuditInTx(NULL_TX, input({ metadata: big }));
    expect(event?.metadata).toEqual({});
    expect(event?.metadataRef).toEqual({
      evidenceKey: 'tenant/ev/1',
      sha256: spilled[0]?.sha256,
      sizeBytes: spilled[0]?.sizeBytes,
    });
    expect(event?.metadataRef?.sizeBytes).toBeGreaterThan(AUDIT_METADATA_MAX_BYTES);
    verifyEvents(ledger.forTenant(TENANT_A));
  });

  it('does not spill metadata that fits', async () => {
    const emitter = createAuditEmitter({
      clock,
      chainStore: () => new MemoryLedger().store(),
      spillMetadata: () => Promise.reject(new Error('should not be called')),
    });
    await expect(emitter.emitAuditInTx(NULL_TX, input())).resolves.toBeDefined();
  });
});

describe('toOutboxMessage', () => {
  it('orders by aggregate and dedupes by event id', async () => {
    const { emitter, outbox } = setup();
    await emitter.emitAudit(input());
    const message = outbox.messages[0];
    expect(message).toEqual(toOutboxMessage(message?.payload as never));
  });
});
