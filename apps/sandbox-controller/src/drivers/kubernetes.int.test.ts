import { afterAll, describe, expect, it } from 'vitest';

import { NETPOL_ENFORCERS } from '../config.js';
import { KubernetesDriver } from './kubernetes.js';

import type { RunNetworkSpec, SandboxSpec } from '@blackwing/contracts';

/**
 * Integration against a real k3s cluster with the `runsc` RuntimeClass (SANDBOX-003, SANDBOX-005). Gated by
 * `SBX_IT=1`; the kubeconfig comes from `KUBECONFIG` (or the in-cluster service account). `SBX_IT_IMAGE` must
 * name a digest-pinned image the nodes can pull, and `SBX_IT_NAMESPACE` a namespace the test may create Pods in.
 * `SBX_IT_NETPOL_ENFORCER` names the CNI that enforces NetworkPolicy on that cluster (calico, cilium or
 * kube-router). Without it the run network is refused, which the test also proves.
 */
const enabled = process.env.SBX_IT === '1';
const image = process.env.SBX_IT_IMAGE ?? '';
const namespace = process.env.SBX_IT_NAMESPACE ?? 'bw-runs';
const enforcer = NETPOL_ENFORCERS.find((name) => name === process.env.SBX_IT_NETPOL_ENFORCER);

const TENANT = '01920000-0000-7000-8000-0000000000b1';
const RUN = '01920000-0000-7000-8000-0000000000b2';
const SANDBOX = '01920000-0000-7000-8000-0000000000b3';

function runNetwork(): RunNetworkSpec {
  return {
    runId: RUN,
    tenantId: TENANT,
    driver: 'kubernetes',
    allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
  };
}

function sandboxSpec(): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: '01920000-0000-7000-8000-0000000000b4',
    persona: 'active-recon',
    imageDigest: image,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 0.25, memoryMiB: 128, pids: 64 },
    env: {},
    mounts: [{ kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 16 }],
    ttlSeconds: 300,
    caBundleRef: 'openbao://pki/run/ca',
  };
}

describe.skipIf(!enabled)('KubernetesDriver against a real k3s cluster', () => {
  const driver = new KubernetesDriver({ namespace, netpolEnforcer: enforcer });

  afterAll(async () => {
    await driver.destroy(SANDBOX);
    await driver.removeNetwork(RUN);
    await driver.close();
  });

  it('refuses a sandbox on a run network that was never provisioned', async () => {
    await expect(driver.create(sandboxSpec())).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
  });

  it('creates a gVisor Pod on its run network, is idempotent, and destroy removes it', async () => {
    await driver.ping();
    await driver.ensureNetwork(runNetwork());
    const handle = await driver.create(sandboxSpec());
    expect((await driver.create(sandboxSpec())).nativeId).toBe(handle.nativeId);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toHaveLength(1);

    await driver.start(SANDBOX);
    await driver.destroy(SANDBOX);
    expect(await driver.list({ tenantId: TENANT, runId: RUN })).toEqual([]);
    await driver.removeNetwork(RUN);
    await expect(driver.removeNetwork(RUN)).resolves.toBeUndefined();
  });
});

// Without a declared enforcer no run network is provisioned, so the run is refused outright (fail closed).
describe.skipIf(!enabled || enforcer !== undefined)(
  'KubernetesDriver without a declared NetworkPolicy enforcer',
  () => {
    it('refuses to provision the run network (SBX_NETPOL_UNSUPPORTED)', async () => {
      const driver = new KubernetesDriver({ namespace });
      await expect(driver.ensureNetwork(runNetwork())).rejects.toMatchObject({
        code: 'SBX_NETPOL_UNSUPPORTED',
      });
      await driver.close();
    });
  },
);
