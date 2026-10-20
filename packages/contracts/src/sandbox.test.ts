import { describe, expect, expectTypeOf, it } from 'vitest';

import * as contracts from './index.js';
import {
  type MountSpec,
  type ReadOnlyMountSpec,
  mountSpecSchema,
  type RunNetworkSpec,
  runNetworkHandleSchema,
  runNetworkSpecSchema,
  type SandboxHandle,
  sandboxHandleSchema,
  type SandboxLifecycleEvent,
  sandboxLifecycleEventSchema,
  sandboxListFilterSchema,
  type SandboxSpec,
  sandboxSpecSchema,
  healthStatusSchema,
  logLineSchema,
  logOptionsSchema,
  stopOptionsSchema,
} from './sandbox.js';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const OTHER_RUN = '01920000-0000-7000-8000-000000000005';
const AT = '2026-10-20T10:00:00.000Z';
const DIGEST = `ghcr.io/tinycrowslab/bw-sandbox@sha256:${'a'.repeat(64)}`;

function networkSpec(overrides: Partial<RunNetworkSpec> = {}): RunNetworkSpec {
  return {
    runId: RUN,
    tenantId: TENANT,
    driver: 'docker',
    allowedDestinations: [
      { kind: 'egress-gateway', host: 'egress-gateway', port: 13128 },
      { kind: 'model-gateway', host: 'model-gateway', port: 13500 },
      { kind: 'run-broker', host: '10.0.0.5', port: 7443 },
    ],
    ...overrides,
  };
}

function sandboxSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: SESSION,
    persona: 'web-api-specialist',
    imageDigest: DIGEST,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: 'bw-run-net' },
    resources: { cpu: 0.5, memoryMiB: 1024, pids: 256 },
    env: { BW_RUN_ID: RUN, HTTPS_PROXY: 'http://egress-gateway:13128' },
    mounts: [
      { kind: 'inputs', source: 's3://inputs/run', target: '/inputs', readOnly: true },
      { kind: 'source', source: 's3://source/run', target: '/src', readOnly: true },
      { kind: 'ca', source: 'openbao://pki/run', target: '/etc/bw/ca', readOnly: true },
      { kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 512 },
    ],
    ttlSeconds: 3600,
    caBundleRef: `openbao://pki/runs/${RUN}/ca-bundle`,
    ...overrides,
  };
}

const handle: SandboxHandle = {
  sandboxId: SANDBOX,
  tenantId: TENANT,
  runId: RUN,
  driver: 'kubernetes',
  nativeId: 'pod-uid-1',
  status: 'running',
  ips: ['10.42.0.7', 'fd00::7'],
  createdAt: AT,
};

const event: SandboxLifecycleEvent = { sandboxId: SANDBOX, runId: RUN, type: 'started', at: AT };

describe('sandbox contracts: round trips', () => {
  it.each([
    ['SandboxSpec', sandboxSpecSchema, sandboxSpec()],
    ['RunNetworkSpec', runNetworkSpecSchema, networkSpec()],
    ['SandboxHandle', sandboxHandleSchema, handle],
    ['SandboxLifecycleEvent', sandboxLifecycleEventSchema, event],
    [
      'SandboxLifecycleEvent (failed)',
      sandboxLifecycleEventSchema,
      { ...event, type: 'failed', reason: 'image pull failed' },
    ],
    [
      'RunNetworkHandle',
      runNetworkHandleSchema,
      {
        runId: RUN,
        tenantId: TENANT,
        networkId: 'n',
        driver: 'docker',
        nativeId: 'abc',
        createdAt: AT,
      },
    ],
    ['HealthStatus', healthStatusSchema, { state: 'healthy', checkedAt: AT }],
    ['LogLine', logLineSchema, { at: AT, stream: 'stderr', line: 'hello' }],
    ['LogOptions', logOptionsSchema, { since: AT, tailLines: 10, follow: true }],
    ['StopOptions', stopOptionsSchema, { graceSeconds: 0, reason: 'kill switch' }],
    [
      'SandboxListFilter',
      sandboxListFilterSchema,
      { tenantId: TENANT, runId: RUN, status: ['running'] },
    ],
  ] as const)('%s parses and re-serialises unchanged', (_name, schema, value) => {
    const parsed: unknown = schema.parse(value);
    expect(parsed).toEqual(value);
    expect(schema.parse(structuredClone(parsed))).toEqual(value);
  });

  it('is exported from the package entry point', () => {
    expect(contracts.sandboxSpecSchema).toBe(sandboxSpecSchema);
    expect(contracts.runNetworkSpecSchema).toBe(runNetworkSpecSchema);
    expect(contracts.sandboxHandleSchema).toBe(sandboxHandleSchema);
    expect(contracts.sandboxLifecycleEventSchema).toBe(sandboxLifecycleEventSchema);
    expect(contracts.mountSpecSchema).toBe(mountSpecSchema);
  });
});

describe('RunNetworkSpec edge cases', () => {
  it('rejects an unknown destination kind', () => {
    const bad = {
      ...networkSpec(),
      allowedDestinations: [{ kind: 'internet', host: 'example.com', port: 443 }],
    };
    expect(runNetworkSpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty allowedDestinations (fail closed: a config bug, not hardening)', () => {
    const result = runNetworkSpecSchema.safeParse(networkSpec({ allowedDestinations: [] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['allowedDestinations']);
  });

  it('rejects duplicate destinations, bad ports and unknown drivers', () => {
    const d = { kind: 'egress-gateway', host: 'egress-gateway', port: 13128 } as const;
    expect(
      runNetworkSpecSchema.safeParse(networkSpec({ allowedDestinations: [d, d] })).success,
    ).toBe(false);
    expect(
      runNetworkSpecSchema.safeParse(networkSpec({ allowedDestinations: [{ ...d, port: 0 }] }))
        .success,
    ).toBe(false);
    expect(runNetworkSpecSchema.safeParse({ ...networkSpec(), driver: 'podman' }).success).toBe(
      false,
    );
  });

  it('requires tenantId and runId (§8.6)', () => {
    const noTenant: Partial<RunNetworkSpec> = networkSpec();
    delete noTenant.tenantId;
    expect(runNetworkSpecSchema.safeParse(noTenant).success).toBe(false);
  });
});

describe('MountSpec', () => {
  it('rejects readOnly:false on a non-tmpfs kind at parse time', () => {
    for (const kind of ['inputs', 'source', 'ca'] as const) {
      expect(
        mountSpecSchema.safeParse({ kind, source: 's3://x/y', target: '/x', readOnly: false })
          .success,
      ).toBe(false);
    }
  });

  it('allows a writable tmpfs and rejects a host source on tmpfs', () => {
    expect(
      mountSpecSchema.safeParse({ kind: 'tmpfs', target: '/tmp', readOnly: false }).success,
    ).toBe(true);
    expect(
      mountSpecSchema.safeParse({
        kind: 'tmpfs',
        source: '/var/run',
        target: '/tmp',
        readOnly: false,
      }).success,
    ).toBe(false);
  });

  it('readOnly is type-enforced for non-tmpfs kinds', () => {
    const ok: MountSpec = { kind: 'ca', source: 'openbao://ca', target: '/ca', readOnly: true };
    // @ts-expect-error readOnly must be literally true for a non-tmpfs mount
    const bad: MountSpec = { kind: 'inputs', source: 's3://i', target: '/i', readOnly: false };
    const tmp: MountSpec = { kind: 'tmpfs', target: '/w', readOnly: false };
    expect([ok, bad, tmp]).toHaveLength(3);
    expectTypeOf<ReadOnlyMountSpec['readOnly']>().toEqualTypeOf<true>();
  });

  it('rejects relative, traversing or unnormalised targets', () => {
    for (const target of ['inputs', '/a/../etc', '/a/', '/a//b', '/./a']) {
      expect(
        mountSpecSchema.safeParse({ kind: 'tmpfs', target, readOnly: false }).success,
        target,
      ).toBe(false);
    }
  });
});

describe('SandboxSpec edge cases', () => {
  it('rejects duplicate mount targets', () => {
    const result = sandboxSpecSchema.safeParse(
      sandboxSpec({
        mounts: [
          { kind: 'inputs', source: 's3://a', target: '/data', readOnly: true },
          { kind: 'tmpfs', target: '/data', readOnly: false },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('duplicate mount target');
  });

  it('requires a digest-pinned image (§8.9)', () => {
    for (const imageDigest of [
      'bw-sandbox:latest',
      'bw-sandbox',
      `bw-sandbox@sha256:${'A'.repeat(64)}`,
    ]) {
      expect(sandboxSpecSchema.safeParse(sandboxSpec({ imageDigest })).success, imageDigest).toBe(
        false,
      );
    }
    expect(
      sandboxSpecSchema.safeParse(
        sandboxSpec({ imageDigest: `localhost:5000/bw/sandbox:1.2@sha256:${'b'.repeat(64)}` }),
      ).success,
    ).toBe(true);
  });

  it('requires tenantId, runId and runtimeClass', () => {
    for (const key of ['tenantId', 'runId', 'runtimeClass', 'imageDigest'] as const) {
      const spec = new Map<string, unknown>(Object.entries(sandboxSpec()));
      spec.delete(key);
      expect(sandboxSpecSchema.safeParse(Object.fromEntries(spec)).success, key).toBe(false);
    }
  });

  it('rejects a network that belongs to another run', () => {
    expect(
      sandboxSpecSchema.safeParse(sandboxSpec({ network: { runId: OTHER_RUN, networkId: 'n' } }))
        .success,
    ).toBe(false);
  });

  it('rejects secret material: PEM in caBundleRef or env, and non-reference caBundleRef', () => {
    const pem = '-----BEGIN PRIVATE KEY-----';
    expect(sandboxSpecSchema.safeParse(sandboxSpec({ caBundleRef: pem })).success).toBe(false);
    expect(sandboxSpecSchema.safeParse(sandboxSpec({ caBundleRef: `x://${pem}` })).success).toBe(
      false,
    );
    expect(sandboxSpecSchema.safeParse(sandboxSpec({ env: { CA: pem } })).success).toBe(false);
  });

  it('rejects invalid env names, unknown keys and out-of-range resources', () => {
    expect(sandboxSpecSchema.safeParse(sandboxSpec({ env: { '1BAD': 'x' } })).success).toBe(false);
    expect(sandboxSpecSchema.safeParse({ ...sandboxSpec(), privileged: true }).success).toBe(false);
    expect(
      sandboxSpecSchema.safeParse(sandboxSpec({ resources: { cpu: 0, memoryMiB: 1024, pids: 1 } }))
        .success,
    ).toBe(false);
    expect(sandboxSpecSchema.safeParse(sandboxSpec({ ttlSeconds: 0 })).success).toBe(false);
  });
});

describe('handle and lifecycle event', () => {
  it('rejects unknown status / event types and non-IP addresses', () => {
    expect(sandboxHandleSchema.safeParse({ ...handle, status: 'paused' }).success).toBe(false);
    expect(sandboxHandleSchema.safeParse({ ...handle, ips: ['not-an-ip'] }).success).toBe(false);
    expect(sandboxLifecycleEventSchema.safeParse({ ...event, type: 'paused' }).success).toBe(false);
  });

  it('a failed event must carry a reason', () => {
    expect(sandboxLifecycleEventSchema.safeParse({ ...event, type: 'failed' }).success).toBe(false);
  });

  it('a list filter must name a tenant (§8.6)', () => {
    expect(sandboxListFilterSchema.safeParse({ runId: RUN }).success).toBe(false);
  });
});
