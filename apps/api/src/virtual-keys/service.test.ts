import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import { VIRTUAL_KEY_PATTERN, DEFAULT_VIRTUAL_KEY_TTL_SECONDS } from '@blackwing/contracts';
import { generateVirtualKey, hashVirtualKey } from '@blackwing/crypto';
import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { createFakeVirtualKeyStore } from './fakes.test-helpers.js';
import { createVirtualKeyMetrics } from './metrics.js';
import { createVirtualKeyService, type VirtualKeyAuditWriter } from './service.js';

import type { AuditEventInput } from '@blackwing/audit';

const T0 = new Date('2026-10-31T10:00:00.000Z');
const TENANT_A = newId();
const TENANT_B = newId();
const RUN = newId();
const SESSION = newId();
const CALLER = { identity: 'agent-runtime' };

function setup(overrides: { now?: Date; ttl?: number; audit?: VirtualKeyAuditWriter } = {}) {
  const store = createFakeVirtualKeyStore();
  const events: AuditEventInput[] = [];
  const audit: VirtualKeyAuditWriter =
    overrides.audit ??
    ((_tx, event) => {
      events.push(event);
      return Promise.resolve();
    });
  const clock = { now: overrides.now ?? T0 };
  const service = createVirtualKeyService({
    store,
    audit,
    systemAudit: () => undefined,
    metrics: createVirtualKeyMetrics(),
    now: () => clock.now,
    ...(overrides.ttl === undefined ? {} : { defaultTtlSeconds: overrides.ttl }),
  });
  return { store, events, service, clock };
}

const mintBody = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT_A,
  runId: RUN,
  sessionId: SESSION,
  persona: 'planner',
  ...overrides,
});

describe('virtual key service: mint', () => {
  it('returns a bwk_ key once, and persists only its hash and prefix', async () => {
    const { store, service } = setup();
    const minted = await service.mint(mintBody(), CALLER);
    expect(minted.key).toMatch(VIRTUAL_KEY_PATTERN);
    const row = store.rows.get(minted.virtualKeyId);
    expect(row?.keySha256.equals(hashVirtualKey(minted.key))).toBe(true);
    expect(row?.keyPrefix).toBe(minted.key.slice(0, 12));
    expect(JSON.stringify([...store.rows.values()])).not.toContain(minted.key);
  });

  it('defaults the lifetime to GATEWAY_VKEY_TTL_SECONDS and honours a shorter explicit ttl', async () => {
    const { service } = setup({ ttl: DEFAULT_VIRTUAL_KEY_TTL_SECONDS });
    const defaulted = await service.mint(mintBody(), CALLER);
    expect(defaulted.expiresAt).toBe(new Date(T0.getTime() + 3_600_000).toISOString());
    const short = await service.mint(mintBody({ ttlSeconds: 60 }), CALLER);
    expect(short.expiresAt).toBe(new Date(T0.getTime() + 60_000).toISOString());
  });

  it('writes vkey.minted in the mint transaction, with ids but never the key', async () => {
    const { events, service } = setup();
    const minted = await service.mint(mintBody(), CALLER);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT_A,
      action: 'vkey.minted',
      actor: { type: 'service', id: 'agent-runtime' },
      target: { type: 'virtual_key', id: minted.virtualKeyId },
      runId: RUN,
    });
    expect(JSON.stringify(events[0])).not.toContain(minted.key);
  });

  it('rolls the mint back when its audit write fails', async () => {
    const { store, service } = setup({
      audit: () => Promise.reject(new Error('audit unavailable')),
    });
    await expect(service.mint(mintBody(), CALLER)).rejects.toThrow('audit unavailable');
    expect(store.rows.size).toBe(0);
  });

  it('fails closed without a tenant, or with a bad persona, ttl, or unknown field', async () => {
    const { service } = setup();
    await expect(service.mint(mintBody({ tenantId: undefined }), CALLER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.mint(mintBody({ persona: 'Planner!' }), CALLER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.mint(mintBody({ ttlSeconds: 86_401 }), CALLER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.mint(mintBody({ ttlSeconds: 0 }), CALLER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.mint(mintBody({ extra: true }), CALLER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.mint(null, CALLER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('carries the budget context and rejects one it cannot parse', async () => {
    const { store, service } = setup();
    const minted = await service.mint(mintBody({ budgetContext: { costCapUsd: 2.5 } }), CALLER);
    expect(store.rows.get(minted.virtualKeyId)?.budgetContext).toEqual({ costCapUsd: 2.5 });
    await expect(
      service.mint(mintBody({ budgetContext: { costCapUsd: -1 } }), CALLER),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('virtual key service: revoke', () => {
  it('gw.vkey.revokeByRun revokes every session key of the run and nothing else', async () => {
    const { events, service } = setup();
    const first = await service.mint(mintBody(), CALLER);
    const second = await service.mint(mintBody({ sessionId: newId() }), CALLER);
    const otherRun = await service.mint(mintBody({ runId: newId() }), CALLER);
    const otherTenant = await service.mint(mintBody({ tenantId: TENANT_B }), CALLER);

    const result = await service.revoke({ tenantId: TENANT_A, runId: RUN }, CALLER);

    expect(result.revokedVirtualKeyIds.toSorted()).toEqual(
      [first.virtualKeyId, second.virtualKeyId].toSorted(),
    );
    expect(await service.authenticate(first.key)).toBeUndefined();
    expect(await service.authenticate(second.key)).toBeUndefined();
    expect(await service.authenticate(otherRun.key)).toBeDefined();
    expect(await service.authenticate(otherTenant.key)).toBeDefined();
    expect(events.at(-1)).toMatchObject({
      action: 'vkey.revoked',
      tenantId: TENANT_A,
      metadata: { trigger: 'run', count: 2 },
    });
  });

  it('revoke by run is idempotent and audits only when a key was revoked', async () => {
    const { events, service } = setup();
    await service.mint(mintBody(), CALLER);
    await service.revoke({ tenantId: TENANT_A, runId: RUN }, CALLER);
    const countAfterFirst = events.length;
    const again = await service.revoke({ tenantId: TENANT_A, runId: RUN }, CALLER);
    expect(again.revokedVirtualKeyIds).toEqual([]);
    expect(events).toHaveLength(countAfterFirst);
  });

  it('revokes by explicit id, and cannot reach another tenant key by id', async () => {
    const { service } = setup();
    const mine = await service.mint(mintBody(), CALLER);
    const theirs = await service.mint(mintBody({ tenantId: TENANT_B }), CALLER);
    const result = await service.revoke(
      { tenantId: TENANT_A, virtualKeyIds: [mine.virtualKeyId, theirs.virtualKeyId] },
      CALLER,
    );
    expect(result.revokedVirtualKeyIds).toEqual([mine.virtualKeyId]);
    expect(await service.authenticate(theirs.key)).toBeDefined();
  });

  it('fails closed on a revoke without a tenant', async () => {
    const { service } = setup();
    await expect(service.revoke({ runId: RUN }, CALLER)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.revoke({ tenantId: TENANT_A, virtualKeyIds: [] }, CALLER),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('virtual key service: authenticate', () => {
  it('accepts a live key and refuses an unknown, malformed or expired one uniformly', async () => {
    const { service, clock } = setup({ ttl: 60 });
    const minted = await service.mint(mintBody(), CALLER);
    expect(await service.authenticate(minted.key)).toMatchObject({
      tenantId: TENANT_A,
      runId: RUN,
      sessionId: SESSION,
      persona: 'planner',
    });
    expect(await service.authenticate(generateVirtualKey())).toBeUndefined();
    expect(await service.authenticate('not-a-key')).toBeUndefined();
    clock.now = new Date(T0.getTime() + 61_000);
    expect(await service.authenticate(minted.key)).toBeUndefined();
  });
});

describe('virtual key service: tracing', () => {
  it('runs mint, validate and revoke in gw.key spans that never carry the key', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const service = createVirtualKeyService({
      store: createFakeVirtualKeyStore(),
      audit: () => Promise.resolve(),
      systemAudit: () => undefined,
      metrics: createVirtualKeyMetrics(),
      tracer: provider.getTracer('test'),
    });
    const minted = await service.mint(mintBody(), CALLER);
    await service.authenticate(minted.key);
    await service.revoke({ tenantId: TENANT_A, runId: RUN }, CALLER);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      'gw.key.mint',
      'gw.key.validate',
      'gw.key.revoke',
    ]);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(minted.key);
  });

  it('marks a failed mint span as an error and rethrows the refusal unchanged', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const service = createVirtualKeyService({
      store: createFakeVirtualKeyStore(),
      audit: () => Promise.resolve(),
      systemAudit: () => undefined,
      metrics: createVirtualKeyMetrics(),
      tracer: provider.getTracer('test'),
    });
    await expect(service.mint({}, CALLER)).rejects.toThrow(ValidationError);
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
