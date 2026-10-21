import { setTimeout as sleep } from 'node:timers/promises';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { CrossTenantAccessError, TenantContextMissingError } from '@blackwing/errors';

import {
  createCrossTenantGuard,
  type CrossTenantDeniedEvent,
  currentTenantId,
  getTenantContext,
  getTenantContextOrThrow,
  hashTenantId,
  perTenantContext,
  resolveTenantContext,
  runWithTenantContext,
  type TenantActor,
  type TenantContext,
  type TenantContextMetrics,
} from './tenant-context.js';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
const USER: TenantActor = { type: 'user', id: 'usr_1' };

function metrics(): TenantContextMetrics & { missing: number; denied: number } {
  const counts = { missing: 0, denied: 0 };
  return Object.assign(counts, {
    contextMissing: () => {
      counts.missing += 1;
    },
    crossTenantDenied: () => {
      counts.denied += 1;
    },
  });
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TenantContextMissingError) return error.meta.reason;
    throw error;
  }
  return undefined;
}

describe('resolveTenantContext', () => {
  it('takes the tenant from the session claim', () => {
    expect(resolveTenantContext({ actor: USER, sessionTenantId: TENANT_A })).toEqual({
      tenantId: TENANT_A,
      actor: USER,
    });
  });

  it('takes the tenant a bearer token is bound to', () => {
    const actor: TenantActor = { type: 'service', id: 'svc_ci' };
    expect(resolveTenantContext({ actor, tokenTenantId: TENANT_B }).tenantId).toBe(TENANT_B);
  });

  it('takes the tenant of a run', () => {
    const actor: TenantActor = { type: 'run', id: 'run_1' };
    expect(resolveTenantContext({ actor, runTenantId: TENANT_A }).actor.type).toBe('run');
  });

  it('normalises to lower case and accepts agreeing sources', () => {
    const context = resolveTenantContext({
      actor: USER,
      sessionTenantId: TENANT_A.toUpperCase(),
      tokenTenantId: TENANT_A,
    });
    expect(context.tenantId).toBe(TENANT_A);
  });

  it('returns a frozen context', () => {
    const context = resolveTenantContext({ actor: USER, sessionTenantId: TENANT_A });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.actor)).toBe(true);
  });

  it.each([undefined, null, ''])('fails closed with no tenant (%j) and counts it', (value) => {
    const m = metrics();
    expect(
      reasonOf(() =>
        resolveTenantContext({ actor: USER, sessionTenantId: value, tokenTenantId: value }, m),
      ),
    ).toBe('missing');
    expect(m.missing).toBe(1);
  });

  it('fails closed on two different tenants (ambiguous)', () => {
    const m = metrics();
    expect(
      reasonOf(() =>
        resolveTenantContext(
          { actor: USER, sessionTenantId: TENANT_A, tokenTenantId: TENANT_B },
          m,
        ),
      ),
    ).toBe('ambiguous');
    expect(m.missing).toBe(1);
  });

  it('fails closed on a tenant that is not a UUID', () => {
    for (const bad of ['tenant-a', "' OR 1=1 --", '0198f0a0-0000-7000-8000-00000000000g']) {
      expect(reasonOf(() => resolveTenantContext({ actor: USER, sessionTenantId: bad }))).toBe(
        'invalid_uuid',
      );
    }
  });

  it('fails closed on an invalid actor', () => {
    const bad = [
      { type: 'admin', id: 'x' },
      { type: 'user', id: '' },
      null,
    ] as unknown as TenantActor[];
    for (const actor of bad) {
      expect(reasonOf(() => resolveTenantContext({ actor, sessionTenantId: TENANT_A }))).toBe(
        'missing',
      );
    }
  });

  it('ignores any extra field on the principal object (a forged claim is not a source)', () => {
    const forged = {
      actor: USER,
      sessionTenantId: TENANT_A,
      tenant_id: TENANT_B,
      tenantId: TENANT_B,
    };
    expect(resolveTenantContext(forged).tenantId).toBe(TENANT_A);
  });

  it('never resolves anything but a canonical UUID (property)', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const reason = reasonOf(() =>
          resolveTenantContext({ actor: USER, sessionTenantId: value }),
        );
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        );
        expect(reason === undefined).toBe(isUuid);
      }),
    );
  });
});

describe('ambient context', () => {
  const contextA: TenantContext = { tenantId: TENANT_A, actor: USER };

  it('is absent outside runWithTenantContext and the accessor throws', () => {
    const m = metrics();
    expect(getTenantContext()).toBeUndefined();
    expect(currentTenantId()).toBeUndefined();
    expect(() => getTenantContextOrThrow(m)).toThrow(TenantContextMissingError);
    expect(m.missing).toBe(1);
  });

  it('is visible to the callback and everything it awaits', async () => {
    const seen = await runWithTenantContext(contextA, async () => {
      await sleep(1);
      await Promise.resolve();
      return new Promise<string | undefined>((resolve) => {
        setImmediate(() => {
          resolve(currentTenantId());
        });
      });
    });
    expect(seen).toBe(TENANT_A);
    expect(currentTenantId()).toBeUndefined();
  });

  it('is restored after the callback throws', () => {
    expect(() =>
      runWithTenantContext(contextA, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getTenantContext()).toBeUndefined();
  });

  it('refuses a hand-built context with a bad tenant', () => {
    expect(() => runWithTenantContext({ tenantId: 'nope', actor: USER }, () => 1)).toThrow(
      TenantContextMissingError,
    );
  });

  it('allows a nested run for the same tenant but never re-scopes to another', () => {
    runWithTenantContext(contextA, () => {
      expect(
        runWithTenantContext({ ...contextA, actor: { type: 'service', id: 's' } }, currentTenantId),
      ).toBe(TENANT_A);
      expect(() => runWithTenantContext({ tenantId: TENANT_B, actor: USER }, () => 1)).toThrow(
        TenantContextMissingError,
      );
      expect(currentTenantId()).toBe(TENANT_A);
    });
  });

  it('isolates many interleaved concurrent requests of different tenants (no bleed)', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) => {
        const tenantId = index % 2 === 0 ? TENANT_A : TENANT_B;
        return runWithTenantContext({ tenantId, actor: USER }, async () => {
          const observed: (string | undefined)[] = [currentTenantId()];
          await sleep(index % 7);
          observed.push(currentTenantId());
          await new Promise<void>((resolve) => setImmediate(resolve));
          observed.push(getTenantContext()?.tenantId);
          await Promise.all([sleep(1), Promise.resolve()]);
          observed.push(currentTenantId());
          return { tenantId, observed };
        });
      }),
    );
    for (const { tenantId, observed } of results) {
      expect(new Set(observed)).toEqual(new Set([tenantId]));
    }
  });
});

describe('perTenantContext', () => {
  it('gives one instance per context and a different one per request', () => {
    const create = vi.fn((context: TenantContext) => ({ tenantId: context.tenantId }));
    const get = perTenantContext(create);
    const a1 = runWithTenantContext(
      { tenantId: TENANT_A, actor: USER },
      () => [get(), get()] as const,
    );
    const a2 = runWithTenantContext({ tenantId: TENANT_A, actor: USER }, () => [get()] as const);
    const b = runWithTenantContext({ tenantId: TENANT_B, actor: USER }, () => [get()] as const);
    expect(a1[0]).toBe(a1[1]);
    expect(a2[0]).not.toBe(a1[0]);
    expect(b[0].tenantId).toBe(TENANT_B);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('throws outside a context', () => {
    expect(() => perTenantContext(() => ({}))()).toThrow(TenantContextMissingError);
  });
});

describe('createCrossTenantGuard', () => {
  const where = { surface: 'GET /v1/things/:id', resource: 'thing:1' };

  it('passes for the context tenant (case-insensitive) without auditing', async () => {
    const audit = vi.fn();
    const guard = createCrossTenantGuard({ audit });
    await runWithTenantContext({ tenantId: TENANT_A, actor: USER }, async () => {
      await guard.assertSameTenant(TENANT_A, where);
      await guard.assertSameTenant(TENANT_A.toUpperCase(), where);
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('denies another tenant: audits tenant.cross_tenant_denied, counts and throws', async () => {
    const events: CrossTenantDeniedEvent[] = [];
    const m = metrics();
    const warn = vi.fn();
    const guard = createCrossTenantGuard({
      audit: (event) => {
        events.push(event);
      },
      metrics: m,
      logger: { warn, error: vi.fn() },
    });
    const error = await runWithTenantContext({ tenantId: TENANT_A, actor: USER }, () =>
      guard.assertSameTenant(TENANT_B, where).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(CrossTenantAccessError);
    expect((error as CrossTenantAccessError).code).toBe('CROSS_TENANT_DENIED');
    expect(events).toEqual([
      {
        action: 'tenant.cross_tenant_denied',
        contextTenantId: TENANT_A,
        resourceTenantId: TENANT_B,
        actor: USER,
        surface: where.surface,
        resource: where.resource,
      },
    ]);
    expect(m.denied).toBe(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TENANT_A);
    expect(logged).not.toContain(TENANT_B);
    expect(logged).toContain(hashTenantId(TENANT_A));
  });

  it('denies a resource with no tenant', async () => {
    const guard = createCrossTenantGuard({ audit: vi.fn() });
    await runWithTenantContext({ tenantId: TENANT_A, actor: USER }, async () => {
      await expect(guard.assertSameTenant(undefined, where)).rejects.toThrow(
        CrossTenantAccessError,
      );
      await expect(guard.assertSameTenant(null, where)).rejects.toThrow(CrossTenantAccessError);
    });
  });

  it('still denies when the audit emitter fails, and logs the failure', async () => {
    const error = vi.fn();
    const guard = createCrossTenantGuard({
      audit: () => Promise.reject(new Error('audit down')),
      logger: { warn: vi.fn(), error },
    });
    await runWithTenantContext({ tenantId: TENANT_A, actor: USER }, async () => {
      await expect(guard.assertSameTenant(TENANT_B, where)).rejects.toThrow(CrossTenantAccessError);
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it('fails closed with no ambient context', async () => {
    const guard = createCrossTenantGuard({ audit: vi.fn() });
    await expect(guard.assertSameTenant(TENANT_A, where)).rejects.toThrow(
      TenantContextMissingError,
    );
  });
});

describe('hashTenantId', () => {
  it('is short, stable and does not contain the id', () => {
    expect(hashTenantId(TENANT_A)).toHaveLength(12);
    expect(hashTenantId(TENANT_A)).toBe(hashTenantId(TENANT_A));
    expect(hashTenantId(TENANT_A)).not.toBe(hashTenantId(TENANT_B));
  });
});
