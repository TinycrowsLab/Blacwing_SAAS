import { describe, expect, it } from 'vitest';

import { sandboxSpecSchema } from '@blackwing/contracts';

import { caTrustFragment, SANDBOX_CA_ENV, SANDBOX_CA_TARGET } from './trust.js';

const CA_REF =
  'openbao://secret/data/tenants/01930000-0000-7000-8000-00000000000a/runs/01930000-0000-7000-8000-0000000000a1/run-ca/cert';

describe('caTrustFragment', () => {
  it('mounts the certificate reference read-only at /etc/bw/ca.pem', () => {
    const fragment = caTrustFragment(CA_REF);
    expect(fragment.mounts).toEqual([
      { kind: 'ca', source: CA_REF, target: '/etc/bw/ca.pem', readOnly: true },
    ]);
    expect(SANDBOX_CA_TARGET).toBe('/etc/bw/ca.pem');
  });

  it('sets the four trust env vars to the mounted certificate', () => {
    const { env } = caTrustFragment(CA_REF);
    expect(env).toEqual({
      NODE_EXTRA_CA_CERTS: '/etc/bw/ca.pem',
      SSL_CERT_FILE: '/etc/bw/ca.pem',
      REQUESTS_CA_BUNDLE: '/etc/bw/ca.pem',
      CURL_CA_BUNDLE: '/etc/bw/ca.pem',
    });
    expect(env).toEqual(SANDBOX_CA_ENV);
  });

  it('never accepts PEM or a non-reference as the source', () => {
    expect(() => caTrustFragment('-----BEGIN PRIVATE KEY-----')).toThrow();
    expect(() => caTrustFragment('plain-text-without-scheme')).toThrow();
    expect(() => caTrustFragment(`openbao://x/-----BEGIN PRIVATE KEY-----`)).toThrow();
  });

  it('merges into a SandboxSpec that the contract accepts, and carries no key material', () => {
    const fragment = caTrustFragment(CA_REF);
    const spec = {
      sandboxId: '01930000-0000-7000-8000-0000000000b1',
      runId: '01930000-0000-7000-8000-0000000000a1',
      tenantId: '01930000-0000-7000-8000-00000000000a',
      sessionId: '01930000-0000-7000-8000-0000000000c1',
      persona: 'code-specialist',
      imageDigest: `registry.example/sandbox@sha256:${'a'.repeat(64)}`,
      runtimeClass: 'gvisor',
      network: {
        runId: '01930000-0000-7000-8000-0000000000a1',
        networkId: 'net-1',
      },
      resources: { cpu: 1, memoryMiB: 2048, pids: 512 },
      env: { ...fragment.env },
      mounts: [...fragment.mounts],
      ttlSeconds: 3600,
      caBundleRef: CA_REF,
    };
    const parsed = sandboxSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.success ? parsed.data : spec)).not.toContain('PRIVATE KEY');
  });
});
