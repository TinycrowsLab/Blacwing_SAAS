import { describe, expect, it } from 'vitest';

import { ForbiddenError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import {
  AUDITOR,
  BASE_AT,
  harness,
  ledgerRow,
  ORG_ADMIN,
  principal,
  RUN_1,
  RUN_2,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { createCursorCodec } from '../pagination/cursor.js';

const seqs = (page: { items: readonly { seq: number }[] }) => page.items.map((item) => item.seq);

describe('AuditQueryService.list: access', () => {
  it('refuses a caller without a tenant context before reading anything (fail closed)', async () => {
    const h = harness();
    await expect(
      h.service.list(principal(['auditor'], { tenantId: null }), {}),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(h.store.transactions).toEqual([]);
  });

  it('refuses a caller without audit:read with FORBIDDEN and opens no transaction', async () => {
    const h = harness();
    const error = await h.service.list(principal(['developer']), {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe('FORBIDDEN');
    expect(h.store.transactions).toEqual([]);
  });

  it('refuses a caller with no roles at all (deny by default)', async () => {
    const h = harness();
    await expect(h.service.list(principal([]), {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets org_admin and auditor read, with the auditor seeing the full row', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    expect(seqs(await h.service.list(ORG_ADMIN, {}))).toEqual([1]);
    expect(seqs(await h.service.list(AUDITOR, {}))).toEqual([1]);
  });

  it('refuses includeChain=true for a caller who is not an auditor, before any read', async () => {
    const h = harness();
    await expect(h.service.list(ORG_ADMIN, { includeChain: 'true' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(h.store.transactions).toEqual([]);
  });
});

describe('AuditQueryService.list: validation', () => {
  it.each([
    ['a naive local timestamp', { from: '2026-10-20T10:00:00' }],
    ['a timestamp with an offset instead of Z', { from: '2026-10-20T10:00:00+01:00' }],
    ['from after to', { from: '2026-10-21T00:00:00Z', to: '2026-10-20T00:00:00Z' }],
    ['an unknown filter key', { actor: 'usr_alice' }],
    ['a limit of zero', { limit: '0' }],
    ['a limit above 200', { limit: '201' }],
    ['a non-numeric limit', { limit: 'ten' }],
    ['a repeated parameter', { action: ['kill.fired', 'kill.completed'] }],
    ['an unknown action', { action: 'auth.unknown' }],
    ['a non-boolean includeChain', { includeChain: 'yes' }],
    ['a runId that is not a UUIDv7', { runId: '00000000-0000-4000-8000-000000000000' }],
    ['a unicode actor id', { actorId: 'usr_é' }],
    ['an actor id with a space', { actorId: 'usr alice' }],
  ])('rejects %s with VALIDATION_FAILED and opens no transaction', async (_label, query) => {
    const h = harness();
    const error = await h.service.list(AUDITOR, query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
    expect(h.store.transactions).toEqual([]);
  });

  it('treats an injection-shaped actor id as data: it matches nothing and is not an error', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    const page = await h.service.list(AUDITOR, { actorId: "x'OR'1'='1" });
    expect(page.items).toEqual([]);
  });
});

describe('AuditQueryService.list: filters and tenant isolation', () => {
  it('filters by action and an inclusive from/to window', async () => {
    const h = harness();
    h.store.insert(
      TENANT_A,
      ledgerRow(1, { action: 'kill.fired', occurredAt: new Date('2026-10-01T00:00:00Z') }),
    );
    h.store.insert(
      TENANT_A,
      ledgerRow(2, { action: 'kill.fired', occurredAt: new Date('2026-10-10T00:00:00Z') }),
    );
    h.store.insert(
      TENANT_A,
      ledgerRow(3, { action: 'kill.completed', occurredAt: new Date('2026-10-10T00:00:00Z') }),
    );
    h.store.insert(
      TENANT_A,
      ledgerRow(4, { action: 'kill.fired', occurredAt: new Date('2026-10-30T00:00:00Z') }),
    );
    const page = await h.service.list(AUDITOR, {
      action: 'kill.fired',
      from: '2026-10-02T00:00:00Z',
      to: '2026-10-10T00:00:00Z',
    });
    expect(seqs(page)).toEqual([2]);
  });

  it('filters by actor, target, run and outcome', async () => {
    const h = harness();
    h.store.insert(
      TENANT_A,
      ledgerRow(1, {
        actor: { type: 'user', id: 'usr_alice' },
        target: { type: 'run', id: RUN_1 },
        runId: RUN_1,
        outcome: 'success',
      }),
    );
    h.store.insert(
      TENANT_A,
      ledgerRow(2, {
        actor: { type: 'user', id: 'usr_bob' },
        target: { type: 'run', id: RUN_2 },
        runId: RUN_2,
        outcome: 'denied',
      }),
    );
    expect(seqs(await h.service.list(AUDITOR, { actorId: 'usr_bob' }))).toEqual([2]);
    expect(seqs(await h.service.list(AUDITOR, { targetId: RUN_1 }))).toEqual([1]);
    expect(seqs(await h.service.list(AUDITOR, { runId: RUN_2 }))).toEqual([2]);
    expect(seqs(await h.service.list(AUDITOR, { outcome: 'denied' }))).toEqual([2]);
  });

  it('never returns another tenant rows, even when the target id matches', async () => {
    const h = harness();
    h.store.insert(TENANT_B, ledgerRow(1, { target: { type: 'run', id: RUN_1 } }));
    const page = await h.service.list(AUDITOR, { targetId: RUN_1 });
    expect(page.items).toEqual([]);
    expect(h.store.transactions).toEqual([TENANT_A]);
  });
});

describe('AuditQueryService.list: cursor pagination', () => {
  it('returns every row exactly once across pages, including rows with the same timestamp', async () => {
    const h = harness();
    for (let seq = 1; seq <= 5; seq += 1) h.store.insert(TENANT_A, ledgerRow(seq));
    const first = await h.service.list(AUDITOR, { limit: '2' });
    expect(seqs(first)).toEqual([5, 4]);
    expect(first.nextCursor).toBeDefined();
    const second = await h.service.list(AUDITOR, { limit: '2', cursor: first.nextCursor });
    expect(seqs(second)).toEqual([3, 2]);
    const third = await h.service.list(AUDITOR, { limit: '2', cursor: second.nextCursor });
    expect(seqs(third)).toEqual([1]);
    expect(third.nextCursor).toBeUndefined();
  });

  it('does not duplicate or skip rows when newer rows arrive between pages', async () => {
    const h = harness();
    for (let seq = 1; seq <= 4; seq += 1) h.store.insert(TENANT_A, ledgerRow(seq));
    const first = await h.service.list(AUDITOR, { limit: '2' });
    h.store.insert(TENANT_A, ledgerRow(5, { occurredAt: new Date('2026-10-21T00:00:00Z') }));
    const second = await h.service.list(AUDITOR, { limit: '2', cursor: first.nextCursor });
    expect(seqs(second)).toEqual([2, 1]);
  });

  it('answers a page that exactly fills the limit with no next cursor', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    h.store.insert(TENANT_A, ledgerRow(2));
    const page = await h.service.list(AUDITOR, { limit: '2' });
    expect(seqs(page)).toEqual([2, 1]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('defaults the page size to 50 and accepts the maximum of 200', async () => {
    const h = harness();
    for (let seq = 1; seq <= 3; seq += 1) h.store.insert(TENANT_A, ledgerRow(seq));
    expect(seqs(await h.service.list(AUDITOR, {}))).toEqual([3, 2, 1]);
    expect(seqs(await h.service.list(AUDITOR, { limit: '200' }))).toEqual([3, 2, 1]);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['an empty string', ''],
    ['a tampered payload', 'AAAA.AAAA'],
  ])('answers %s with INVALID_CURSOR (400)', async (_label, cursor) => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    const error = await h.service.list(AUDITOR, { cursor }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('INVALID_CURSOR');
    expect((error as { httpStatus?: number }).httpStatus).toBe(400);
  });

  it('rejects a cursor replayed against different filters', async () => {
    const h = harness();
    for (let seq = 1; seq <= 3; seq += 1) h.store.insert(TENANT_A, ledgerRow(seq));
    const first = await h.service.list(AUDITOR, { limit: '1' });
    await expect(
      h.service.list(AUDITOR, { limit: '1', action: 'kill.fired', cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rejects a cursor signed with another key (forged)', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    h.store.insert(TENANT_A, ledgerRow(2));
    const forged = createCursorCodec('y'.repeat(48)).encode({
      k: [BASE_AT, 1],
      d: 'desc',
      s: 'anything',
    });
    await expect(h.service.list(AUDITOR, { cursor: forged })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});

describe('AuditQueryService.list: response shape and redaction', () => {
  it('hides hash, prevHash and ip-like fields by default; only auditors see metadata and email', async () => {
    const h = harness();
    h.store.insert(
      TENANT_A,
      ledgerRow(2, {
        metadata: { scope: 'tenant' },
        metadataRef: {
          evidenceKey: 'tenant/evidence/abc',
          sha256: 'a'.repeat(64),
          sizeBytes: 20_000,
        },
      }),
    );
    const auditor = await h.service.list(AUDITOR, {});
    expect(auditor.items[0]).toMatchObject({
      metadata: { scope: 'tenant' },
      actor: { type: 'user', id: 'usr_alice', email: 'alice@example.test' },
    });
    expect(auditor.items[0]).not.toHaveProperty('hash');
    expect(auditor.items[0]).not.toHaveProperty('ip');

    const admin = await h.service.list(ORG_ADMIN, {});
    expect(admin.items[0]).toMatchObject({
      metadata: {},
      actor: { type: 'user', id: 'usr_alice' },
    });
    expect(admin.items[0]).not.toHaveProperty('metadataRef');
    expect(auditor.items[0]).toHaveProperty('metadataRef');
    expect(admin.items[0]?.actor).not.toHaveProperty('email');
  });

  it('returns hex hash and prevHash with includeChain=true for an auditor', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1));
    h.store.insert(TENANT_A, ledgerRow(2));
    const page = await h.service.list(AUDITOR, { includeChain: 'true' });
    const [newest, oldest] = page.items;
    expect(newest?.hash).toBe('02'.repeat(32));
    expect(newest?.prevHash).toBe('01'.repeat(32));
    expect(oldest?.prevHash).toBeNull();
  });
});

describe('AuditQueryService.list: the audit record', () => {
  it('records one audit.queried event in the same transaction, with filter keys but never filter values', async () => {
    const h = harness();
    h.store.insert(TENANT_A, ledgerRow(1, { actor: { type: 'user', id: 'usr_secret_value' } }));
    await h.service.list(AUDITOR, {
      actorId: 'usr_secret_value',
      action: 'kill.fired',
      limit: '10',
    });
    expect(h.store.recorded).toHaveLength(1);
    const [event] = h.store.recorded;
    expect(event).toMatchObject({
      tenantId: TENANT_A,
      action: 'audit.queried',
      actor: { type: 'user', id: 'usr_caller' },
      target: { type: 'tenant', id: TENANT_A },
      outcome: 'success',
      metadata: { filterKeys: ['action', 'actorId'], limit: 10, returned: 1, includeChain: false },
    });
    expect(JSON.stringify(event)).not.toContain('usr_secret_value');
  });

  it('records a query that returns nothing too', async () => {
    const h = harness();
    await h.service.list(AUDITOR, {});
    expect(h.store.recorded).toHaveLength(1);
    expect(h.store.recorded[0]?.metadata).toMatchObject({ returned: 0 });
  });

  it('records no event for a refused query', async () => {
    const h = harness();
    await h.service.list(principal(['developer']), {}).catch(() => undefined);
    expect(h.store.recorded).toEqual([]);
  });

  it('observes the answering role and latency for metrics', async () => {
    const h = harness();
    await h.service.list(AUDITOR, {});
    await h.service.list(ORG_ADMIN, {});
    expect(h.observed.map((o) => o.role)).toEqual(['auditor', 'org_admin']);
    expect(h.observed.every((o) => o.latencySeconds >= 0)).toBe(true);
  });
});
