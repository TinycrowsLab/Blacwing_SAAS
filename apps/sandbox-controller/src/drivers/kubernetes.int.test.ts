import { afterAll, describe, expect, it } from 'vitest';

import { KubernetesDriver } from './kubernetes.js';

import type { SandboxSpec } from '@blackwing/contracts';

/**
 * Integration against a real k3s cluster with the `runsc` RuntimeClass (SANDBOX-003). Gated by `SBX_IT=1`;
 * the kubeconfig comes from `KUBECONFIG` (or the in-cluster service account). `SBX_IT_IMAGE` must name a
 * digest-pinned image the nodes can pull, and `SBX_IT_NAMESPACE` a namespace the test may create Pods in.
 */
const enabled = process.env.SBX_IT === '1';
const image = process.env.SBX_IT_IMAGE ?? '';
const namespace = process.env.SBX_IT_NAMESPACE ?? 'bw-runs';

const TENANT = '01920000-0000-7000-8000-0000000000b1';
const RUN = '01920000-0000-7000-8000-0000000000b2';
const SANDBOX = '01920000-0000-7000-8000-0000000000b3';

describe.skipIf(!enabled)('KubernetesDriver against a real k3s cluster', () => {
  const driver = new KubernetesDriver({ namespace });

  afterAll(async () => {
    await driver.destroy(SANDBOX);
    await driver.close();
  });

  it('creates a gVisor Pod with the pinned digest, is idempotent, and destroy removes it', async () => {
    const spec: SandboxSpec = {
      sandboxId: SANDBOX,
      runId: RUN,
      tenantId: TENANT,
      sessionId: '01920000-0000-7000-8000-0000000000b4',
      persona: 'active-recon',
      imageDigest: image,
      runtimeClass: 'gvisor',
      network: { runId: RUN, networkId: `bw-it-${RUN}` },
      resources: { cpu: 0.25, memoryMiB: 128, pids: 64 },
      env: {},
      mounts: [{ kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 16 }],
      ttlSeconds: 300,
      caBundleRef: 'openbao://pki/run/ca',
    };
    await driver.ping();
    const handle = await driver.create(spec);
    expect((await driver.create(spec)).nativeId).toBe(handle.nativeId);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toHaveLength(1);

    await driver.start(SANDBOX);
    await driver.destroy(SANDBOX);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toEqual([]);
  });
});
