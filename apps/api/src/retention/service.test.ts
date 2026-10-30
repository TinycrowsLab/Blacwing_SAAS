import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { RETENTION_DEFAULTS } from '@blackwing/contracts';
import {
  ForbiddenError,
  PreconditionFailedError,
  PreconditionRequiredError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';

import { InMemoryRetentionStore } from './memory.js';
import { createRetentionMetrics } from './metrics.js';
import { RetentionService } from './service.js';

import type { RetentionPrincipal } from './ports.js';

const TENANT = '0190f6a2-7b1c-7d2e-8f3a-123456789abc';
const OTHER = '0190f6a2-7b1c-7d2e-8f3a-abcdef012345';
const USER = '0190f6a2-7b1c-7d2e-8f3a-000000000001';

const admin = (tenantId: string | null = TENANT): RetentionPrincipal => ({
  type: 'user',
  id: USER,
  tenantId,
  roles: ['org_admin'],
});

function build(now = () => new Date('2026-10-28T09:00:00.000Z')) {
  const store = new InMemoryRetentionStore({ now: () => now().toISOString() });
  const metrics = createRetentionMetrics(new Registry());
  const service = new RetentionService({ store, metrics, now });
  return { store, metrics, service };
}

const update = (...policies: unknown[]) => ({ policies });

describe('RetentionService.get', () => {
  it('reports every class, with the platform default where no row exists', async () => {
    const { service } = build();
    const { body, etag } = await service.get(admin());
    expect(body.policies.map((p) => p.dataClass)).toEqual([
      'findings',
      'evidence',
      'logs',
      'transcripts',
      'reports',
      'oob_interactions',
    ]);
    const findings = body.policies.find((p) => p.dataClass === 'findings');
    expect(findings).toEqual({
      dataClass: 'findings',
      retentionDays: RETENTION_DEFAULTS.findings.retentionDays,
      minRetentionDays: RETENTION_DEFAULTS.findings.minRetentionDays,
      enabled: true,
      legalHoldOverrides: false,
      updatedAt: null,
    });
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('returns the same ETag for an unchanged set, and a new one after a change', async () => {
    const { service } = build();
    const first = await service.get(admin());
    const again = await service.get(admin());
    expect(again.etag).toBe(first.etag);
    await service.replace(
      admin(),
      update({ dataClass: 'logs', retentionDays: 60, enabled: true }),
      first.etag,
    );
    const after = await service.get(admin());
    expect(after.etag).not.toBe(first.etag);
  });

  it('fails closed without a tenant context', async () => {
    const { service } = build();
    await expect(service.get(admin(null))).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('requires settings:read (a developer is refused)', async () => {
    const { service } = build();
    await expect(
      service.get({ type: 'user', id: USER, tenantId: TENANT, roles: ['developer'] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('RetentionService.replace', () => {
  it('applies a change, returns the new set and a new ETag, audits and counts it', async () => {
    const { service, store, metrics } = build();
    const { etag } = await service.get(admin());
    const result = await service.replace(
      admin(),
      update({ dataClass: 'evidence', retentionDays: 60, enabled: true }),
      etag,
    );
    const evidence = result.body.policies.find((p) => p.dataClass === 'evidence');
    expect(evidence).toMatchObject({ retentionDays: 60, enabled: true, minRetentionDays: 30 });
    expect(evidence?.updatedAt).toBe('2026-10-28T09:00:00.000Z');
    expect(result.etag).not.toBe(etag);

    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]).toMatchObject({
      action: 'config.changed',
      tenantId: TENANT,
      outcome: 'success',
      actor: { type: 'user', id: USER },
      target: { type: 'config', id: 'retention_policies' },
      metadata: {
        area: 'retention',
        dataClass: 'evidence',
        fromRetentionDays: 365,
        toRetentionDays: 60,
        fromEnabled: true,
        toEnabled: true,
      },
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('retention_policy_updates_total{data_class="evidence"} 1');
  });

  it('records the token id in the audit actor when the call used an API token', async () => {
    const { service, store } = build();
    const { etag } = await service.get(admin());
    await service.replace(
      { ...admin(), tokenId: 'bw_pat_1' },
      update({ dataClass: 'logs', retentionDays: 45, enabled: true }),
      etag,
    );
    expect(store.audit[0]?.actor).toEqual({ type: 'user', id: USER, tokenId: 'bw_pat_1' });
  });

  it('rejects a value below the platform floor with a validation error and changes nothing', async () => {
    const { service, store } = build();
    const { etag } = await service.get(admin());
    await expect(
      service.replace(
        admin(),
        update({ dataClass: 'evidence', retentionDays: 29, enabled: true }),
        etag,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.audit).toHaveLength(0);
    const after = await service.get(admin());
    expect(after.body.policies.find((p) => p.dataClass === 'evidence')?.retentionDays).toBe(365);
  });

  it('disables a class down to its floor, never below and never forever', async () => {
    const { service } = build();
    const { etag } = await service.get(admin());
    const result = await service.replace(
      admin(),
      update({ dataClass: 'transcripts', retentionDays: 30, enabled: false }),
      etag,
    );
    expect(result.body.policies.find((p) => p.dataClass === 'transcripts')).toMatchObject({
      retentionDays: 30,
      minRetentionDays: 30,
      enabled: false,
    });
    await expect(
      service.replace(
        admin(),
        update({ dataClass: 'transcripts', retentionDays: 365, enabled: false }),
        result.etag,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('never accepts legal_hold_overrides, however it is spelled (strict body)', async () => {
    const { service } = build();
    const { etag } = await service.get(admin());
    await expect(
      service.replace(
        admin(),
        update({
          dataClass: 'evidence',
          retentionDays: 60,
          enabled: true,
          legalHoldOverrides: false,
        }),
        etag,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const result = await service.get(admin());
    expect(result.body.policies.map((p) => p.legalHoldOverrides)).not.toContain(true);
  });

  it('requires If-Match: 428 when absent, 412 when stale, and accepts *', async () => {
    const { service } = build();
    const body = update({ dataClass: 'logs', retentionDays: 45, enabled: true });
    await expect(service.replace(admin(), body, undefined)).rejects.toBeInstanceOf(
      PreconditionRequiredError,
    );
    const { etag } = await service.get(admin());
    await service.replace(admin(), body, etag);
    await expect(service.replace(admin(), body, etag)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(service.replace(admin(), body, '*')).resolves.toBeDefined();
  });

  it('lets exactly one of two concurrent writers win; the other sees 412', async () => {
    const { service } = build();
    const { etag } = await service.get(admin());
    const a = service.replace(
      admin(),
      update({ dataClass: 'logs', retentionDays: 45, enabled: true }),
      etag,
    );
    const b = service.replace(
      admin(),
      update({ dataClass: 'logs', retentionDays: 50, enabled: true }),
      etag,
    );
    const [first, second] = await Promise.allSettled([a, b]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' ? second.reason : undefined).toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('writes no audit event and no metric for a no-op update, and keeps the ETag', async () => {
    const { service, store, metrics } = build();
    const { etag } = await service.get(admin());
    const result = await service.replace(
      admin(),
      update({ dataClass: 'evidence', retentionDays: 365, enabled: true }),
      etag,
    );
    expect(result.etag).toBe(etag);
    expect(store.audit).toHaveLength(0);
    expect(await metrics.registry.metrics()).not.toContain('retention_policy_updates_total{');
  });

  it('keeps tenants apart: a change for one tenant never shows for another', async () => {
    const { service, store } = build();
    const { etag } = await service.get(admin());
    await service.replace(
      admin(),
      update({ dataClass: 'reports', retentionDays: 120, enabled: true }),
      etag,
    );
    const other = await service.get(admin(OTHER));
    expect(other.body.policies.find((p) => p.dataClass === 'reports')).toMatchObject({
      retentionDays: RETENTION_DEFAULTS.reports.retentionDays,
      updatedAt: null,
    });
    expect(store.audit.every((event) => event.tenantId === TENANT)).toBe(true);
  });

  it('rejects a principal without settings:write and never writes', async () => {
    const { service, store } = build();
    const { etag } = await service.get(admin());
    const auditor: RetentionPrincipal = {
      type: 'user',
      id: USER,
      tenantId: TENANT,
      roles: ['auditor'],
    };
    await expect(
      service.replace(
        auditor,
        update({ dataClass: 'logs', retentionDays: 45, enabled: true }),
        etag,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.audit).toHaveLength(0);
  });

  it('rolls back the policy write when the audit write fails (no change without its audit event)', async () => {
    const { store, metrics } = build();
    const service = new RetentionService({
      store: {
        read: (tenantId) => store.read(tenantId),
        transact: (tenantId, fn) =>
          store.transact(tenantId, (tx) =>
            fn({
              ...tx,
              appendAudit: () => Promise.reject(new Error('ledger down')),
            }),
          ),
      },
      metrics,
    });
    const { etag } = await service.get(admin());
    await expect(
      service.replace(
        admin(),
        update({ dataClass: 'logs', retentionDays: 45, enabled: true }),
        etag,
      ),
    ).rejects.toThrow('ledger down');
    const after = await service.get(admin());
    expect(after.body.policies.find((p) => p.dataClass === 'logs')?.retentionDays).toBe(90);
    expect(after.etag).toBe(etag);
  });
});
