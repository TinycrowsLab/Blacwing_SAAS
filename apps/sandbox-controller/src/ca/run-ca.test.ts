import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createControllerMetrics } from '../metrics.js';
import { createInMemoryEgressCaRegistry } from './egress-registry.js';
import { createRunCaLogAuditEmitter, createRunCaProvisioner, RUN_CA_GRACE_MS } from './run-ca.js';
import {
  captureAudit,
  fakeOpenBao,
  NOW,
  OTHER_TENANT,
  RUN,
  RUN_END,
  SA_EXPIRY,
  TENANT,
} from './test-helpers.js';
import { describeCertificate } from './x509.js';

import type { Counter } from 'prom-client';

const iso = (ms: number): string => new Date(ms).toISOString();
const counterValue = async (counter: Counter): Promise<number> =>
  (await counter.get()).values[0]?.value ?? 0;
const issueInput = {
  tenantId: TENANT,
  runId: RUN,
  runWindowEndsAt: RUN_END,
  standingAuthorisationExpiresAt: SA_EXPIRY,
};

function setup(options: { failOn?: (method: string, path: string) => boolean } = {}) {
  const openbao = fakeOpenBao(options.failOn);
  const egress = createInMemoryEgressCaRegistry();
  const audit = captureAudit();
  const metrics = createControllerMetrics('0.0.0', 'test');
  const provisioner = createRunCaProvisioner({
    openbao,
    egress,
    audit,
    metrics,
    now: () => NOW,
  });
  return { openbao, egress, audit, metrics, provisioner };
}

describe('issueRunCa: certificate', () => {
  it('issues a CA:TRUE pathlen-0 certificate with the run CN, backdated for skew and capped at run end + grace', async () => {
    const { provisioner } = setup();
    const ref = await provisioner.issueRunCa(issueInput);
    const window = describeCertificate(ref.certificatePem);

    expect(window.notBefore.getTime()).toBe(NOW.getTime() - 60_000);
    expect(window.notBefore.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(window.notAfter.getTime()).toBe(Date.parse(RUN_END) + RUN_CA_GRACE_MS);
    expect(ref.notAfter).toBe(window.notAfter.toISOString());
    expect(ref.fingerprintSha256).toBe(window.fingerprintSha256);
    expect(ref.tenantId).toBe(TENANT);
    expect(ref.runId).toBe(RUN);
  });

  it('caps notAfter at the standing authorisation expiry when that comes first (§8.1)', async () => {
    const { provisioner } = setup();
    const expiry = '2026-10-30T10:30:00.000Z';
    const ref = await provisioner.issueRunCa({
      ...issueInput,
      standingAuthorisationExpiresAt: expiry,
    });
    expect(ref.notAfter).toBe(expiry);
    expect(describeCertificate(ref.certificatePem).notAfter.getTime()).toBe(Date.parse(expiry));
  });

  it('refuses a window that has already ended, or a standing authorisation already expired (fail closed)', async () => {
    const { provisioner, openbao } = setup();
    await expect(
      provisioner.issueRunCa({
        ...issueInput,
        runWindowEndsAt: '2026-10-30T08:00:00.000Z',
        standingAuthorisationExpiresAt: '2026-10-30T08:00:00.000Z',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      provisioner.issueRunCa({ ...issueInput, standingAuthorisationExpiresAt: iso(NOW.getTime()) }),
    ).rejects.toThrow(ValidationError);
    expect(openbao.records.size).toBe(0);
  });

  it('rejects malformed input at the boundary, including extra keys', async () => {
    const { provisioner, openbao } = setup();
    await expect(provisioner.issueRunCa({ ...issueInput, runId: 'not-a-uuid' })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      provisioner.issueRunCa({ ...issueInput, runWindowEndsAt: '2026-10-30' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      provisioner.issueRunCa({ ...issueInput, privateKey: 'x' } as unknown as typeof issueInput),
    ).rejects.toThrow(ValidationError);
    expect(openbao.records.size).toBe(0);
  });
});

describe('issueRunCa: secret handling', () => {
  it('stores the private key and the certificate in OpenBao under the tenant run path only', async () => {
    const { provisioner, openbao } = setup();
    const ref = await provisioner.issueRunCa(issueInput);
    const base = `secret/data/tenants/${TENANT}/runs/${RUN}/run-ca`;
    expect([...openbao.records.keys()].sort()).toEqual([`${base}/cert`, `${base}/key`]);
    expect(ref.keyRef).toBe(`openbao://${base}/key`);
    expect(ref.caBundleRef).toBe(`openbao://${base}/cert`);
    expect(openbao.records.get(`${base}/key`)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('returns only the public certificate: no private key appears anywhere in the returned reference', async () => {
    const { provisioner, openbao } = setup();
    const ref = await provisioner.issueRunCa(issueInput);
    const serialised = JSON.stringify(ref);
    expect(serialised).not.toContain('PRIVATE KEY');
    expect(serialised).not.toContain(
      openbao.records.get(`secret/data/tenants/${TENANT}/runs/${RUN}/run-ca/key`) ?? 'missing',
    );
    expect(ref.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
  });

  it('is idempotent: a second call for the same run returns the same CA and writes nothing new', async () => {
    const { provisioner, openbao, audit, metrics } = setup();
    const first = await provisioner.issueRunCa(issueInput);
    const writes = openbao.calls.filter((c) => c.method === 'POST').length;
    const second = await provisioner.issueRunCa(issueInput);
    expect(second.fingerprintSha256).toBe(first.fingerprintSha256);
    expect(second.certificatePem).toBe(first.certificatePem);
    expect(openbao.calls.filter((c) => c.method === 'POST').length).toBe(writes);
    expect(audit.events.filter((e) => e.type === 'run_ca.issued')).toHaveLength(1);
    expect(await counterValue(metrics.caIssued)).toBe(1);
  });

  it('shares one CA between concurrent sandboxes of the same run', async () => {
    const { provisioner, openbao } = setup();
    const [a, b] = await Promise.all([
      provisioner.issueRunCa(issueInput),
      provisioner.issueRunCa(issueInput),
    ]);
    expect(a.fingerprintSha256).toBe(b.fingerprintSha256);
    expect(openbao.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('fails closed when the secret store is unavailable: no CA, no egress publish, no audit', async () => {
    const { provisioner, egress, audit, openbao, metrics } = setup({
      failOn: (method) => method === 'POST',
    });
    await expect(provisioner.issueRunCa(issueInput)).rejects.toMatchObject({
      code: 'KEK_UNAVAILABLE',
    });
    expect(openbao.records.size).toBe(0);
    expect(egress.lookup({ tenantId: TENANT, runId: RUN })).toBeUndefined();
    expect(audit.events).toHaveLength(0);
    expect(await counterValue(metrics.caIssued)).toBe(0);
  });

  it('fails closed when the store is unreachable on the existence check', async () => {
    const { provisioner, openbao } = setup({ failOn: (method) => method === 'GET' });
    await expect(provisioner.issueRunCa(issueInput)).rejects.toBeInstanceOf(AppError);
    expect(openbao.records.size).toBe(0);
  });

  it('rolls back the key and the certificate when publishing to the egress gateway fails', async () => {
    const { openbao, audit, metrics } = setup();
    const failing = createRunCaProvisioner({
      openbao,
      egress: {
        publish: () => Promise.reject(new AppError('INTERNAL', 'control plane down')),
        withdraw: () => Promise.resolve(),
      },
      audit,
      metrics,
      now: () => NOW,
    });
    await expect(failing.issueRunCa(issueInput)).rejects.toThrow('control plane down');
    expect(openbao.records.size).toBe(0);
    expect(audit.events).toHaveLength(0);
  });

  it('rolls back when the audit event cannot be written, so an unaudited CA never stays live', async () => {
    const { openbao, egress, metrics } = setup();
    const provisioner = createRunCaProvisioner({
      openbao,
      egress,
      audit: { emit: () => Promise.reject(new AppError('INTERNAL', 'audit down')) },
      metrics,
      now: () => NOW,
    });
    await expect(provisioner.issueRunCa(issueInput)).rejects.toThrow('audit down');
    expect(openbao.records.size).toBe(0);
    expect(egress.lookup({ tenantId: TENANT, runId: RUN })).toBeUndefined();
  });

  it('keeps the key out of the audit events and the structured logs', async () => {
    const { provisioner, openbao, audit } = setup();
    await provisioner.issueRunCa(issueInput);
    const keyPem =
      openbao.records.get(`secret/data/tenants/${TENANT}/runs/${RUN}/run-ca/key`) ?? '';
    const event = audit.events[0];
    if (event === undefined) throw new Error('no audit event was emitted');

    const lines: string[] = [];
    const logger = createLogger('sandbox-controller', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => lines.push(line) },
    });
    await createRunCaLogAuditEmitter(logger).emit(event);
    const logged = lines.join('');

    expect(logged).toContain(event.fingerprintSha256);
    expect(logged).not.toContain('PRIVATE KEY');
    expect(logged).not.toContain(keyPem);
    expect(logged).not.toContain('CERTIFICATE');
  });
});

describe('issueRunCa: audit and egress', () => {
  it('publishes the certificate and fingerprint to the egress registry and audits the issuance', async () => {
    const { provisioner, egress, audit } = setup();
    const ref = await provisioner.issueRunCa(issueInput);
    const entry = egress.lookup({ tenantId: TENANT, runId: RUN });
    expect(entry?.certificatePem).toBe(ref.certificatePem);
    expect(entry?.fingerprintSha256).toBe(ref.fingerprintSha256);
    expect(entry).not.toHaveProperty('privateKeyPem');
    expect(audit.events).toEqual([
      {
        type: 'run_ca.issued',
        tenantId: TENANT,
        runId: RUN,
        fingerprintSha256: ref.fingerprintSha256,
        notAfter: ref.notAfter,
        occurredAt: NOW.toISOString(),
      },
    ]);
  });

  it('never resolves another tenant CA for the same run id', async () => {
    const { provisioner, egress, openbao } = setup();
    await provisioner.issueRunCa(issueInput);
    expect(egress.lookup({ tenantId: OTHER_TENANT, runId: RUN })).toBeUndefined();
    const other = await provisioner.issueRunCa({ ...issueInput, tenantId: OTHER_TENANT });
    expect(other.keyRef).toContain(`tenants/${OTHER_TENANT}/`);
    expect(openbao.records.size).toBe(4);
  });
});

describe('revokeRunCa', () => {
  it('deletes the key and certificate (later reads 404), withdraws the run and audits the fingerprint', async () => {
    const { provisioner, openbao, egress, audit, metrics } = setup();
    const ref = await provisioner.issueRunCa(issueInput);
    await provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN });

    expect(openbao.records.size).toBe(0);
    expect(egress.lookup({ tenantId: TENANT, runId: RUN })).toBeUndefined();
    expect(audit.events.at(-1)).toEqual({
      type: 'run_ca.revoked',
      tenantId: TENANT,
      runId: RUN,
      fingerprintSha256: ref.fingerprintSha256,
      occurredAt: NOW.toISOString(),
    });
    expect(await counterValue(metrics.caRevoked)).toBe(1);
  });

  it('is idempotent: revoking again succeeds and audits nothing new', async () => {
    const { provisioner, audit, metrics } = setup();
    await provisioner.issueRunCa(issueInput);
    await provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN });
    await provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN });
    expect(audit.events.filter((e) => e.type === 'run_ca.revoked')).toHaveLength(1);
    expect(await counterValue(metrics.caRevoked)).toBe(1);
  });

  it('touches only the named tenant: the same run id under another tenant keeps its CA', async () => {
    const { provisioner, openbao, egress } = setup();
    await provisioner.issueRunCa(issueInput);
    await provisioner.issueRunCa({ ...issueInput, tenantId: OTHER_TENANT });
    await provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN });
    expect(openbao.records.size).toBe(2);
    expect(egress.lookup({ tenantId: OTHER_TENANT, runId: RUN })).toBeDefined();
  });

  it('fails closed when the store is unreachable, so nothing is reported as revoked', async () => {
    const { provisioner, audit } = setup({ failOn: (method) => method === 'GET' });
    await expect(provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN })).rejects.toBeInstanceOf(
      AppError,
    );
    expect(audit.events).toHaveLength(0);
  });

  it('rejects an invalid scope', async () => {
    const { provisioner } = setup();
    await expect(provisioner.revokeRunCa({ tenantId: 'x', runId: RUN })).rejects.toThrow(
      ValidationError,
    );
  });
});
