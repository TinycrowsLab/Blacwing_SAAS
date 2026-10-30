import { describe, expect, it } from 'vitest';

import { ConflictError, ValidationError } from '@blackwing/errors';

import { httpError, FakeKube } from '../drivers/kube-fake.js';
import { KUBE_LABEL, podName, renderPod } from '../drivers/kubernetes-config.js';
import { SbxNetpolUnsupportedError, SbxNetworkUnavailableError } from '../errors.js';
import { runPolicyNames } from './kubernetes-policy.js';
import {
  KubernetesNetworkProvisioner,
  type KubeCall,
  type NetpolApplyResult,
  type NetLogger,
} from './kubernetes.js';
import { BUILT_IN_HARDENING_CONFIG, buildKubernetesHardening } from '../spec/hardening.js';

import type { RunNetworkEvent } from './provisioner.js';
import type { KubeApi } from '../drivers/kubernetes-api.js';
import type { RunNetworkSpec, SandboxSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01920000-0000-7000-8000-00000000000f';
const RUN = '01920000-0000-7000-8000-000000000002';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const NS = 'bw-runs';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const DIGEST = `bw-sandbox@sha256:${'c'.repeat(64)}`;

function netSpec(overrides: Partial<RunNetworkSpec> = {}): RunNetworkSpec {
  return {
    runId: RUN,
    tenantId: TENANT,
    driver: 'kubernetes',
    allowedDestinations: [
      { kind: 'egress-gateway', host: 'egress-gateway', port: 13128 },
      { kind: 'model-gateway', host: 'model-gateway', port: 13500 },
      { kind: 'run-broker', host: 'run-broker', port: 13400 },
    ],
    ...overrides,
  };
}

/** The pod of a sandbox in RUN, as the driver would render it (for the live-sandbox refusal). */
function livePod(kube: FakeKube): void {
  const sandbox: SandboxSpec = {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: '01920000-0000-7000-8000-000000000003',
    persona: 'active-recon',
    imageDigest: DIGEST,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 0.5, memoryMiB: 512, pids: 128 },
    env: {},
    mounts: [],
    ttlSeconds: 600,
    caBundleRef: 'openbao://pki/run/ca',
  };
  kube.pods.set(
    podName(SANDBOX),
    renderPod(sandbox, {
      namespace: NS,
      now: NOW,
      hardening: buildKubernetesHardening(
        { persona: sandbox.persona, resources: sandbox.resources },
        { config: BUILT_IN_HARDENING_CONFIG },
      ),
      tmpfsCapMiB: 1024,
    }),
  );
}

/** A KubeCall without retries: the provisioner's own logic is under test. */
const direct =
  (kube: KubeApi): KubeCall =>
  (fn) =>
    fn(kube);

function harness(
  options: {
    kube?: FakeKube;
    enforcer?: 'calico' | undefined;
    api?: KubeApi;
  } = {},
) {
  const kube = options.kube ?? new FakeKube();
  const events: RunNetworkEvent[] = [];
  const applies: NetpolApplyResult[] = [];
  const warnings: Record<string, unknown>[] = [];
  const logger: NetLogger = {
    warn: (fields) => {
      warnings.push(fields);
    },
  };
  const provisioner = new KubernetesNetworkProvisioner(direct(options.api ?? kube), {
    namespace: NS,
    now: () => NOW,
    enforcer: 'enforcer' in options ? options.enforcer : 'calico',
    onEvent: (event) => events.push(event),
    onApply: (result) => applies.push(result),
    logger,
  });
  return { provisioner, kube, events, applies, warnings };
}

/** Fails the egress allow of a run, to model a partial apply (default-deny applied, allow failed). */
class EgressCreateFails extends FakeKube {
  override async createNetworkPolicy(
    namespace: string,
    policy: Parameters<FakeKube['createNetworkPolicy']>[1],
  ) {
    if ((policy.metadata?.name ?? '').endsWith('-egress')) throw httpError(500);
    return super.createNetworkPolicy(namespace, policy);
  }
}

describe('KubernetesNetworkProvisioner.ensureNetwork', () => {
  it('applies the default-deny and the egress allow, and returns the run network handle', async () => {
    const { provisioner, kube, events, applies } = harness();
    const handle = await provisioner.ensureNetwork(netSpec());

    const names = runPolicyNames(RUN);
    expect(kube.netpols.has(names.defaultDeny)).toBe(true);
    expect(kube.netpols.has(names.egress)).toBe(true);
    expect(handle).toEqual({
      runId: RUN,
      tenantId: TENANT,
      networkId: `bw-run-${RUN}`,
      driver: 'kubernetes',
      nativeId: `np-uid-${String(kube.netpols.get(names.egress)?.metadata?.resourceVersion)}`,
      createdAt: NOW.toISOString(),
    });
    expect(applies).toEqual(['applied']);
    expect(events).toEqual([
      { type: 'run_network.created', runId: RUN, tenantId: TENANT, at: NOW.toISOString() },
    ]);
  });

  it('is idempotent: a repeat reconciles in place, returns the same handle and emits no second created', async () => {
    const { provisioner, kube, events } = harness();
    const first = await provisioner.ensureNetwork(netSpec());
    const second = await provisioner.ensureNetwork(netSpec());
    expect(second.nativeId).toBe(first.nativeId);
    expect(kube.netpols.size).toBe(2);
    expect(events).toHaveLength(1);
  });

  it('reconciles a drifted egress policy back to the declared destinations', async () => {
    const { provisioner, kube } = harness();
    await provisioner.ensureNetwork(netSpec());
    await provisioner.ensureNetwork(
      netSpec({
        allowedDestinations: [{ kind: 'model-gateway', host: 'model-gateway', port: 13500 }],
      }),
    );
    const egress = kube.netpols.get(runPolicyNames(RUN).egress);
    expect(egress?.spec?.egress).toHaveLength(2);
    expect(JSON.stringify(egress)).not.toContain('egress-gateway');
  });

  it('refuses every network when no NetworkPolicy enforcer is declared, applying nothing', async () => {
    const { provisioner, kube, applies } = harness({ enforcer: undefined });
    await expect(provisioner.ensureNetwork(netSpec())).rejects.toBeInstanceOf(
      SbxNetpolUnsupportedError,
    );
    await expect(provisioner.ensureNetwork(netSpec())).rejects.toMatchObject({
      code: 'SBX_NETPOL_UNSUPPORTED',
    });
    expect(kube.netpols.size).toBe(0);
    expect(applies).toEqual(['unsupported', 'unsupported']);
  });

  it('partial apply: the default-deny lands, the egress allow fails, the call fails closed', async () => {
    const kube = new EgressCreateFails();
    const { provisioner, applies, warnings } = harness({ kube });

    await expect(provisioner.ensureNetwork(netSpec())).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
    const names = runPolicyNames(RUN);
    expect(kube.netpols.has(names.defaultDeny)).toBe(true);
    expect(kube.netpols.has(names.egress)).toBe(false);
    expect(applies).toEqual(['failed']);
    expect(warnings).toEqual([{ component: 'netprovisioner', run_id: RUN, reason: 'unexpected' }]);
  });

  it('wraps a non-scope failure as SBX_NETWORK_UNAVAILABLE and keeps the cause for the server log', async () => {
    const kube = new FakeKube();
    kube.failures.push({ op: 'readNetworkPolicy', error: httpError(403) });
    const { provisioner } = harness({ kube });
    const error = await provisioner.ensureNetwork(netSpec()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SbxNetworkUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('refuses a run network that belongs to another tenant and leaves the existing policies alone', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await provisioner.ensureNetwork(netSpec({ tenantId: OTHER_TENANT }));
    const before = kube.netpols.get(runPolicyNames(RUN).egress);

    await expect(provisioner.ensureNetwork(netSpec())).rejects.toBeInstanceOf(ConflictError);
    expect(kube.netpols.get(runPolicyNames(RUN).egress)).toEqual(before);
  });

  it('rejects a destination that is not the in-cluster Service, applying nothing (no IP allow)', async () => {
    const { provisioner, kube } = harness();
    await expect(
      provisioner.ensureNetwork(
        netSpec({ allowedDestinations: [{ kind: 'run-broker', host: '10.0.0.5', port: 7443 }] }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(kube.netpols.size).toBe(0);
  });

  it('rejects a spec for another driver and a malformed spec before any cluster call', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await expect(provisioner.ensureNetwork(netSpec({ driver: 'docker' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      provisioner.ensureNetwork({ ...netSpec(), runId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(kube.calls).toEqual([]);
  });

  it('logs a failed apply with the run id and a bounded reason, never an API body', async () => {
    const kube = new FakeKube();
    kube.failures.push({ op: 'readNetworkPolicy', error: httpError(500) });
    const { provisioner, warnings } = harness({ kube });
    await expect(provisioner.ensureNetwork(netSpec())).rejects.toBeInstanceOf(
      SbxNetworkUnavailableError,
    );
    expect(warnings).toEqual([{ component: 'netprovisioner', run_id: RUN, reason: 'unexpected' }]);
  });
});

describe('KubernetesNetworkProvisioner.removeNetwork', () => {
  it('deletes both policies and emits run_network.destroyed with the tenant', async () => {
    const { provisioner, kube, events } = harness();
    await provisioner.ensureNetwork(netSpec());
    await provisioner.removeNetwork(RUN);

    expect(kube.netpols.size).toBe(0);
    expect(events.at(-1)).toEqual({
      type: 'run_network.destroyed',
      runId: RUN,
      tenantId: TENANT,
      at: NOW.toISOString(),
    });
  });

  it('is idempotent: removing an absent network resolves and emits nothing', async () => {
    const { provisioner, events } = harness();
    await provisioner.ensureNetwork(netSpec());
    await provisioner.removeNetwork(RUN);
    await expect(provisioner.removeNetwork(RUN)).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === 'run_network.destroyed')).toHaveLength(1);
  });

  it('refuses while sandboxes of the run still exist, keeping the policies in place', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await provisioner.ensureNetwork(netSpec());
    livePod(kube);

    await expect(provisioner.removeNetwork(RUN)).rejects.toBeInstanceOf(ConflictError);
    expect(kube.netpols.size).toBe(2);
  });

  it('rejects a malformed run id before any cluster call', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await expect(provisioner.removeNetwork('../other')).rejects.toBeInstanceOf(ValidationError);
    expect(kube.calls).toEqual([]);
  });

  it('removes the policies only, and does not match pods of another run', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await provisioner.ensureNetwork(netSpec());
    const other = `${KUBE_LABEL.runId}=01920000-0000-7000-8000-0000000000ff`;
    expect(await kube.listPods(NS, other)).toEqual([]);
    await provisioner.removeNetwork(RUN);
    expect(kube.calls).toContain('listPods');
  });
});

describe('KubernetesNetworkProvisioner.assertNetwork', () => {
  it('passes when both policies exist and belong to the tenant', async () => {
    const { provisioner } = harness();
    await provisioner.ensureNetwork(netSpec());
    await expect(provisioner.assertNetwork(RUN, TENANT)).resolves.toBeUndefined();
  });

  it('blocks sandbox creation when the run network is missing or only partly applied', async () => {
    const kube = new FakeKube();
    const { provisioner } = harness({ kube });
    await expect(provisioner.assertNetwork(RUN, TENANT)).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
    await provisioner.ensureNetwork(netSpec());
    kube.netpols.delete(runPolicyNames(RUN).egress);
    await expect(provisioner.assertNetwork(RUN, TENANT)).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
  });

  it('refuses a run network of another tenant', async () => {
    const { provisioner } = harness();
    await provisioner.ensureNetwork(netSpec());
    await expect(provisioner.assertNetwork(RUN, OTHER_TENANT)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses without a declared enforcer, even when policies exist', async () => {
    const kube = new FakeKube();
    const enforced = harness({ kube });
    await enforced.provisioner.ensureNetwork(netSpec());
    const unenforced = harness({ kube, enforcer: undefined });
    await expect(unenforced.provisioner.assertNetwork(RUN, TENANT)).rejects.toMatchObject({
      code: 'SBX_NETPOL_UNSUPPORTED',
    });
  });
});
