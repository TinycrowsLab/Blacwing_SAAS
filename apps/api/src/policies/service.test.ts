import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@blackwing/contracts';
import {
  ConcurrencyError,
  type ActivationResult,
  PolicyVersionNotFoundError,
  type NewPolicyVersion,
  type PolicyVersion,
} from '@blackwing/db';
import { ForbiddenError, ValidationError } from '@blackwing/errors';
import { policySourceSha256 } from '@blackwing/policy';

import { createTenantPolicyMetrics } from './metrics.js';
import { createTenantPolicyEngine } from './policy-engine.js';
import {
  TenantPolicyService,
  type TenantPolicyPrincipal,
  type TenantPolicyStore,
} from './service.js';

import type { Logger } from '@blackwing/logger';

const TENANT_A = '0190a000-0000-7000-8000-00000000000a';
const TENANT_B = '0190a000-0000-7000-8000-00000000000b';
const AUTHOR = '0190a000-0000-7000-8000-0000000000aa';
const PERMIT = 'permit (principal, action, resource);\n';
const FORBID_ALL = 'forbid (principal, action, resource);\n';
const INVALID = 'permit (principal, action, resource) when { principal.nope };\n';

const admin = (tenantId: string | null = TENANT_A): TenantPolicyPrincipal => ({
  id: AUTHOR,
  tenantId,
  roles: ['org_admin'],
});
const readOnly = (tenantId: string | null = TENANT_A): TenantPolicyPrincipal => ({
  id: AUTHOR,
  tenantId,
  roles: ['auditor'],
});

/**
 * An in-memory store with the repository's semantics: append-only versions per tenant, the first version is
 * the empty policy, one active pointer, expected-version checks and tenant-scoped reads. The database
 * behaviour itself is proven by the `tenant-policy.rls` integration tests in `@blackwing/db`.
 */
class MemoryPolicyStore implements TenantPolicyStore {
  readonly rows = new Map<string, PolicyVersion[]>();
  /** tenant -> the active version number (the single active pointer). */
  private readonly pointer = new Map<string, number>();
  readonly events: string[] = [];
  createCalls = 0;

  private view(tenantId: string, row: PolicyVersion): PolicyVersion {
    return { ...row, active: this.pointer.get(tenantId) === row.version };
  }

  private find(tenantId: string, version: number): PolicyVersion | undefined {
    const row = this.list(tenantId).find((v) => v.version === version);
    return row === undefined ? undefined : this.view(tenantId, row);
  }

  private list(tenantId: string): PolicyVersion[] {
    let versions = this.rows.get(tenantId);
    if (versions === undefined) {
      versions = [];
      this.rows.set(tenantId, versions);
    }
    return versions;
  }

  private put(
    tenantId: string,
    input: Omit<PolicyVersion, 'id' | 'createdAt' | 'active'>,
  ): PolicyVersion {
    const row: PolicyVersion = {
      ...input,
      active: false,
      id: `${tenantId}-${String(input.version)}`,
      createdAt: new Date(0),
    };
    this.list(tenantId).push(row);
    return this.view(tenantId, row);
  }

  getActive(tenantId: string): Promise<PolicyVersion | undefined> {
    const version = this.pointer.get(tenantId);
    return Promise.resolve(version === undefined ? undefined : this.find(tenantId, version));
  }

  getVersion(tenantId: string, version: number): Promise<PolicyVersion | undefined> {
    return Promise.resolve(this.find(tenantId, version));
  }

  listVersions(tenantId: string, limit: number) {
    return Promise.resolve(
      this.list(tenantId)
        .slice()
        .reverse()
        .slice(0, limit)
        .map((row) => this.view(tenantId, row))
        .map((v) => ({
          id: v.id,
          tenantId: v.tenantId,
          version: v.version,
          sha256: v.sha256,
          author: v.author,
          active: v.active,
          note: v.note,
          createdAt: v.createdAt,
        })),
    );
  }

  createVersion(input: NewPolicyVersion): Promise<PolicyVersion> {
    this.createCalls += 1;
    const versions = this.list(input.tenantId);
    if (versions.length === 0) {
      this.put(input.tenantId, {
        tenantId: input.tenantId,
        version: 1,
        cedarSource: '',
        ruleBuilderJson: null,
        sha256: policySourceSha256(''),
        author: input.actorId,
        note: 'initial empty tenant policy',
      });
    }
    const next = versions.length + 1;
    return Promise.resolve(
      this.put(input.tenantId, {
        tenantId: input.tenantId,
        version: next,
        cedarSource: input.cedarSource,
        ruleBuilderJson: null,
        sha256: input.sha256,
        author: input.actorId,
        note: input.note ?? null,
      }),
    );
  }

  activate(input: {
    tenantId: string;
    version: number;
    expectedActiveVersion: number | null;
    actorId: string;
  }) {
    return this.move(input.tenantId, input.version, input.expectedActiveVersion, 'activated');
  }

  rollback(input: {
    tenantId: string;
    toVersion: number;
    expectedActiveVersion: number;
    actorId: string;
  }) {
    return this.move(input.tenantId, input.toVersion, input.expectedActiveVersion, 'rolled_back');
  }

  private move(
    tenantId: string,
    version: number,
    expected: number | null,
    kind: string,
  ): Promise<ActivationResult> {
    // Rejections, not synchronous throws: the repository's methods are promises too.
    return Promise.resolve().then(() => {
      const target = this.find(tenantId, version);
      if (target === undefined) throw new PolicyVersionNotFoundError(version);
      const previousVersion = this.pointer.get(tenantId) ?? null;
      if (previousVersion !== expected) throw new ConcurrencyError('policy active version');
      if (previousVersion === version) return { record: target, previousVersion, changed: false };
      this.pointer.set(tenantId, version);
      this.events.push(`${kind}:${String(version)}`);
      return { record: { ...target, active: true }, previousVersion, changed: true };
    });
  }
}

const silentLogger: Pick<Logger, 'info'> = { info: () => undefined };

function setup(
  store = new MemoryPolicyStore(),
  validate?: (s: string) => { ok: boolean; errors: string[] },
) {
  const metrics = createTenantPolicyMetrics(new Registry());
  const service = new TenantPolicyService({
    store,
    metrics,
    logger: silentLogger,
    ...(validate === undefined ? {} : { validate }),
  });
  return { store, metrics, service };
}

/** The rejection of `promise`, or `undefined` when it resolves. Callers assert on the result. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('TenantPolicyService: writes and the authorisation gate', () => {
  it('lets an org admin create versions and stores the canonical source with its digest', async () => {
    const { service, store, metrics } = setup();
    const crlf = await service.createVersion(admin(), {
      source: 'permit (principal, action, resource);   \r\n\r\n',
    });
    expect(crlf.cedarSource).toBe(PERMIT);
    expect(crlf.sha256).toBe(policySourceSha256(PERMIT));
    const again = await service.createVersion(admin(), { source: PERMIT });
    expect(again.sha256).toBe(crlf.sha256);
    expect(again.version).toBe(3);
    expect(await metrics.registry.metrics()).toContain('policy_versions_total 2');
    expect(store.rows.get(TENANT_A)?.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('refuses writes from a caller without policy:write, before anything is stored', async () => {
    const { service, store } = setup();
    await expect(service.createVersion(readOnly(), { source: PERMIT })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(store.createCalls).toBe(0);
  });

  it('fails closed for a caller with no tenant context', async () => {
    const { service } = setup();
    expect(
      await captureError(service.createVersion(admin(null), { source: PERMIT })),
    ).toMatchObject({ code: 'TENANT_CONTEXT_MISSING', httpStatus: 403 });
    expect(await captureError(service.getActive(admin(null)))).toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
      httpStatus: 403,
    });
  });

  it('refuses a source over the size cap and a note over its cap, storing nothing', async () => {
    const { service, store } = setup();
    const huge = 'a'.repeat(LIMITS.policySourceMaxBytes + 1);
    expect(await captureError(service.createVersion(admin(), { source: huge }))).toMatchObject({
      code: 'POLICY_SOURCE_TOO_LARGE',
      httpStatus: 413,
    });
    await expect(
      service.createVersion(admin(), {
        source: PERMIT,
        note: 'n'.repeat(LIMITS.policyNoteMax + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.createCalls).toBe(0);
  });

  it('accepts a source at the size cap exactly', async () => {
    const { service } = setup();
    const padded = `${PERMIT}${' '.repeat(LIMITS.policySourceMaxBytes - Buffer.byteLength(PERMIT))}`;
    expect(Buffer.byteLength(padded)).toBe(LIMITS.policySourceMaxBytes);
    await expect(service.createVersion(admin(), { source: padded })).resolves.toMatchObject({
      version: 2,
    });
  });
});

describe('TenantPolicyService: activation and rollback', () => {
  it('activates a validated version and counts the move', async () => {
    const { service, metrics } = setup();
    const v2 = await service.createVersion(admin(), { source: PERMIT });
    const result = await service.activate(admin(), {
      version: v2.version,
      expectedActiveVersion: null,
    });
    expect(result).toMatchObject({ changed: true, previousVersion: null });
    expect(result.record.active).toBe(true);
    expect(await metrics.registry.metrics()).toContain(
      'policy_activations_total{kind="activated"} 1',
    );
  });

  it('never activates a version that fails validation', async () => {
    const { service, store } = setup();
    const bad = await service.createVersion(admin(), { source: INVALID });
    expect(
      await captureError(
        service.activate(admin(), { version: bad.version, expectedActiveVersion: null }),
      ),
    ).toMatchObject({ code: 'POLICY_VALIDATION_FAILED', httpStatus: 422 });
    expect(store.events).toEqual([]);
    expect(await service.getActive(admin())).toBeUndefined();
  });

  it('refuses a tenant policy that declares a baseline id', async () => {
    const { service } = setup();
    const shadow = await service.createVersion(admin(), {
      source: '@id("baseline.floor")\npermit (principal, action, resource);\n',
    });
    expect(
      await captureError(
        service.activate(admin(), { version: shadow.version, expectedActiveVersion: null }),
      ),
    ).toMatchObject({ code: 'POLICY_VALIDATION_FAILED' });
  });

  it('reports a missing version as POLICY_VERSION_NOT_FOUND and never reveals another tenant', async () => {
    const { service, store } = setup();
    await service.createVersion(admin(TENANT_B), { source: PERMIT });
    expect(
      await captureError(
        service.activate(admin(TENANT_A), { version: 2, expectedActiveVersion: null }),
      ),
    ).toMatchObject({ code: 'POLICY_VERSION_NOT_FOUND', httpStatus: 404 });
    expect(store.rows.get(TENANT_A) ?? []).toEqual([]);
  });

  it('rolls back to an earlier validated version and keeps history', async () => {
    const { service, metrics } = setup();
    const v2 = await service.createVersion(admin(), { source: PERMIT });
    const v3 = await service.createVersion(admin(), { source: FORBID_ALL });
    await service.activate(admin(), { version: v2.version, expectedActiveVersion: null });
    await service.activate(admin(), { version: v3.version, expectedActiveVersion: 2 });
    const result = await service.rollback(admin(), { toVersion: 2 });
    expect(result).toMatchObject({ changed: true, previousVersion: 3 });
    expect((await service.getActive(admin()))?.version).toBe(2);
    expect((await service.listVersions(admin())).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(await metrics.registry.metrics()).toContain(
      'policy_activations_total{kind="rolled_back"} 1',
    );
  });

  it('refuses a rollback with no active version, or to a version that is not earlier', async () => {
    const { service } = setup();
    expect(await captureError(service.rollback(admin(), { toVersion: 1 }))).toMatchObject({
      code: 'POLICY_NO_ACTIVE_VERSION',
      httpStatus: 409,
    });
    const v2 = await service.createVersion(admin(), { source: PERMIT });
    await service.activate(admin(), { version: v2.version, expectedActiveVersion: null });
    expect(await captureError(service.rollback(admin(), { toVersion: 2 }))).toMatchObject({
      code: 'POLICY_ROLLBACK_TARGET_NOT_EARLIER',
      httpStatus: 409,
    });
    expect(await captureError(service.rollback(admin(), { toVersion: 9 }))).toMatchObject({
      code: 'POLICY_ROLLBACK_TARGET_NOT_EARLIER',
      httpStatus: 409,
    });
  });

  it('refuses a rollback to a version that no longer validates', async () => {
    const validate = (source: string) =>
      source.includes('nope')
        ? { ok: false, errors: ['unknown attribute'] }
        : { ok: true, errors: [] };
    const { service } = setup(new MemoryPolicyStore(), validate);
    const bad = await service.createVersion(admin(), { source: INVALID });
    const good = await service.createVersion(admin(), { source: PERMIT });
    await service.activate(admin(), { version: good.version, expectedActiveVersion: null });
    expect(await captureError(service.rollback(admin(), { toVersion: bad.version }))).toMatchObject(
      { code: 'POLICY_VALIDATION_FAILED', httpStatus: 422 },
    );
  });

  it('refuses a stale expected active version', async () => {
    const { service } = setup();
    const v2 = await service.createVersion(admin(), { source: PERMIT });
    await service.activate(admin(), { version: v2.version, expectedActiveVersion: null });
    const v3 = await service.createVersion(admin(), { source: FORBID_ALL });
    await expect(
      service.activate(admin(), { version: v3.version, expectedActiveVersion: null }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });
});

describe('TenantPolicyService: reads and the effective set', () => {
  it('lets a read-only role read, and never write', async () => {
    const { service } = setup();
    await service.createVersion(admin(), { source: PERMIT });
    expect(await service.listVersions(readOnly())).toHaveLength(2);
    await expect(service.getVersion(readOnly(), 2)).resolves.toMatchObject({ version: 2 });
    await expect(
      service.activate(readOnly(), { version: 2, expectedActiveVersion: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('keeps tenants apart: a tenant only ever sees its own versions', async () => {
    const { service } = setup();
    await service.createVersion(admin(TENANT_A), { source: PERMIT });
    expect(await service.listVersions(admin(TENANT_B))).toEqual([]);
    expect(await captureError(service.getVersion(admin(TENANT_B), 2))).toMatchObject({
      code: 'POLICY_VERSION_NOT_FOUND',
      httpStatus: 404,
    });
    const v2 = await service.createVersion(admin(TENANT_B), { source: FORBID_ALL });
    await service.activate(admin(TENANT_B), { version: v2.version, expectedActiveVersion: null });
    expect((await service.getActive(admin(TENANT_A)))?.version).toBeUndefined();
  });

  it('returns the baseline alone for a tenant with no active version, and baseline first otherwise', async () => {
    const { service } = setup();
    const baselineOnly = await service.getEffectivePolicySet(admin());
    expect(baselineOnly.tenant).toBeNull();
    expect(baselineOnly.baseline.source.length).toBeGreaterThan(0);

    const v2 = await service.createVersion(admin(), { source: PERMIT });
    await service.activate(admin(), { version: v2.version, expectedActiveVersion: null });
    const effective = await service.getEffectivePolicySet(admin());
    expect(Object.keys(effective)).toEqual(['baseline', 'tenant']);
    expect(effective.tenant).toMatchObject({ version: '2', sha256: v2.sha256, source: PERMIT });
  });
});

describe('createTenantPolicyEngine: Cedar resource check', () => {
  const engine = createTenantPolicyEngine();
  const permissions = ['policy:read', 'policy:write'];

  it('allows an edit only inside the principal tenant', () => {
    expect(
      engine.authorize({ id: AUTHOR, tenantId: TENANT_A, permissions }, 'edit', TENANT_A).decision,
    ).toBe('allow');
    expect(
      engine.authorize({ id: AUTHOR, tenantId: TENANT_A, permissions }, 'edit', TENANT_B).decision,
    ).toBe('deny');
  });

  it('denies without the RBAC permission, even inside the tenant', () => {
    expect(
      engine.authorize(
        { id: AUTHOR, tenantId: TENANT_A, permissions: ['policy:read'] },
        'edit',
        TENANT_A,
      ).decision,
    ).toBe('deny');
  });
});
