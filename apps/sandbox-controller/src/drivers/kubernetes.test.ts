import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ConflictError, ValidationError } from '@blackwing/errors';

import { DEFAULT_SANDBOX_WORKSPACE_MIB } from '../config.js';
import { SbxDriverUnavailableError, SbxRuntimeMissingError } from '../errors.js';
import { createDriver } from './index.js';
import { httpError, FakeKube, netError } from './kube-fake.js';
import { KUBE_LABEL, podName, renderPod, START_GATE } from './kubernetes-config.js';
import { KubernetesDriver, splitLogs } from './kubernetes.js';
import { renderRunNetworkPolicies, runPolicyNames } from '../net/kubernetes-policy.js';
import { BUILT_IN_HARDENING_CONFIG, buildKubernetesHardening } from '../spec/hardening.js';

import type { SandboxDriver } from './driver.js';
import type { SandboxLifecycleEvent, SandboxSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01920000-0000-7000-8000-00000000000f';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const OTHER_SANDBOX = '01920000-0000-7000-8000-000000000005';
const OTHER_RUN = '01920000-0000-7000-8000-000000000006';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const DIGEST = `bw-sandbox@sha256:${'c'.repeat(64)}`;
const NS = 'bw-runs';

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: SESSION,
    persona: 'active-recon',
    imageDigest: DIGEST,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 0.5, memoryMiB: 512, pids: 128 },
    env: {},
    mounts: [{ kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 64 }],
    ttlSeconds: 600,
    caBundleRef: 'openbao://pki/run/ca',
    ...overrides,
  };
}

function renderFor(input: SandboxSpec) {
  return renderPod(input, {
    namespace: NS,
    now: NOW,
    hardening: buildKubernetesHardening(
      { persona: input.persona, resources: input.resources },
      { config: BUILT_IN_HARDENING_CONFIG },
    ),
    tmpfsCapMiB: DEFAULT_SANDBOX_WORKSPACE_MIB,
  });
}

/** The run network of RUN as the provisioner applies it (SANDBOX-005), already in place. */
function seedRunNetwork(kube: FakeKube): void {
  const { defaultDeny, egress } = renderRunNetworkPolicies(
    {
      runId: RUN,
      tenantId: TENANT,
      driver: 'kubernetes',
      allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
    },
    NS,
  );
  for (const policy of [defaultDeny, egress]) {
    const name = policy.metadata?.name ?? '';
    const seeded = structuredClone(policy);
    seeded.metadata ??= {};
    Object.assign(seeded.metadata, { uid: `seed-${name}`, resourceVersion: '1' });
    kube.netpols.set(name, seeded);
  }
}

function harness(
  overrides: { kube?: FakeKube; events?: SandboxLifecycleEvent[]; netpolEnforcer?: 'calico' } = {},
) {
  const kube = overrides.kube ?? new FakeKube();
  seedRunNetwork(kube);
  const events = overrides.events ?? [];
  const creates: string[] = [];
  const driver = new KubernetesDriver({
    api: kube,
    namespace: NS,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    random: () => 0,
    callTimeoutMs: 50,
    netpolEnforcer: overrides.netpolEnforcer ?? 'calico',
    onEvent: (event) => events.push(event),
    onCreate: (result) => creates.push(result),
  });
  return { driver, kube, events, creates };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('KubernetesDriver.create', () => {
  it('creates one Pod with the runtime class, the digest and the no-service-account policy', async () => {
    const { driver, kube, creates } = harness();
    const handle = await driver.create(spec());

    const pod = kube.pods.get(podName(SANDBOX));
    expect(pod?.spec?.runtimeClassName).toBe('gvisor');
    expect(pod?.spec?.containers[0]?.image).toBe(DIGEST);
    expect(pod?.spec?.automountServiceAccountToken).toBe(false);
    expect(pod?.spec?.restartPolicy).toBe('Never');
    expect(pod?.spec?.schedulingGates).toEqual([{ name: START_GATE }]);
    expect(handle).toMatchObject({
      sandboxId: SANDBOX,
      tenantId: TENANT,
      runId: RUN,
      driver: 'kubernetes',
      nativeId: 'uid-1',
      status: 'created',
      ips: [],
      createdAt: NOW.toISOString(),
    });
    expect(creates).toEqual(['created']);
  });

  it('is idempotent by sandbox id: a repeated create returns the same Pod', async () => {
    const { driver, kube, creates } = harness();
    const first = await driver.create(spec());
    const second = await driver.create(spec());

    expect(second.nativeId).toBe(first.nativeId);
    expect(kube.pods.size).toBe(1);
    expect(kube.calls.filter((op) => op === 'createPod')).toHaveLength(1);
    expect(creates).toEqual(['created', 'existing']);
  });

  it('returns the winning Pod when create hits a 409 from an earlier attempt that landed', async () => {
    const kube = new FakeKube();
    const { driver } = harness({ kube });
    // An earlier attempt created the Pod, but this create's first read did not see it (a stale read).
    await kube.createPod(NS, renderFor(spec()));
    const realRead = kube.readPod.bind(kube);
    let staleOnce = true;
    kube.readPod = async (namespace, name) => {
      if (staleOnce) {
        staleOnce = false;
        return undefined;
      }
      return realRead(namespace, name);
    };
    const handle = await driver.create(spec());
    expect(handle.nativeId).toBe('uid-1');
    expect(kube.calls.filter((op) => op === 'createPod')).toHaveLength(2);
    expect(kube.pods.size).toBe(1);
  });

  it('refuses a sandbox id that already belongs to another tenant', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    await expect(driver.create(spec({ tenantId: OTHER_TENANT }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(kube.pods.size).toBe(1);
  });

  it('fails fast with SBX_RUNTIME_MISSING when the RuntimeClass is not defined, creating nothing', async () => {
    const kube = new FakeKube();
    kube.runtimeClasses.clear();
    const { driver, events, creates } = harness({ kube });
    await expect(driver.create(spec())).rejects.toBeInstanceOf(SbxRuntimeMissingError);
    await expect(driver.create(spec())).rejects.toMatchObject({ code: 'SBX_RUNTIME_MISSING' });
    expect(kube.calls).not.toContain('createPod');
    expect(events.map((e) => e.type)).toEqual(['failed', 'failed']);
    expect(creates).toEqual(['failed', 'failed']);
  });

  it('never falls back to the default runtime: a RuntimeClass whose handler is not runsc is refused', async () => {
    const kube = new FakeKube();
    kube.runtimeClasses.set('gvisor', { metadata: { name: 'gvisor' }, handler: 'runc' });
    const { driver } = harness({ kube });
    await expect(driver.create(spec())).rejects.toMatchObject({ code: 'SBX_RUNTIME_MISSING' });
    await expect(driver.create(spec())).rejects.toThrow('handler runc');
    expect(kube.calls).not.toContain('createPod');
  });

  it('rejects a tag-only image before any cluster call', async () => {
    const { driver, kube } = harness();
    await expect(driver.create(spec({ imageDigest: 'bw-sandbox:latest' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(kube.calls).toEqual([]);
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const kube = new FakeKube();
    kube.failures.push(
      { op: 'readRuntimeClass', error: httpError(429) },
      { op: 'readRuntimeClass', error: httpError(503) },
    );
    const { driver } = harness({ kube });
    await expect(driver.create(spec())).resolves.toMatchObject({ status: 'created' });
    expect(kube.calls.filter((op) => op === 'readRuntimeClass')).toHaveLength(3);
  });

  it('retries unreachable-API network errors', async () => {
    const kube = new FakeKube();
    kube.failures.push({ op: 'readPod', error: netError('ECONNREFUSED') });
    const { driver } = harness({ kube });
    await expect(driver.create(spec())).resolves.toMatchObject({ status: 'created' });
    expect(kube.calls.filter((op) => op === 'readPod')).toHaveLength(2);
  });

  it('gives up after the attempt cap with SBX_DRIVER_UNAVAILABLE and no response body in the message', async () => {
    const kube = new FakeKube();
    for (let i = 0; i < 8; i += 1) kube.failures.push({ op: 'readPod', error: httpError(503) });
    const { driver, events } = harness({ kube });
    await expect(driver.create(spec())).rejects.toMatchObject({
      code: 'SBX_DRIVER_UNAVAILABLE',
      message: 'kubernetes API request failed (HTTP 503)',
    });
    expect(kube.calls.filter((op) => op === 'readPod')).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual(['failed']);
  });

  it('does not retry a non-transient API error and surfaces it fail-closed', async () => {
    const kube = new FakeKube();
    kube.failures.push({ op: 'readPod', error: httpError(403) });
    const { driver } = harness({ kube });
    await expect(driver.create(spec())).rejects.toBeInstanceOf(SbxDriverUnavailableError);
    expect(kube.calls.filter((op) => op === 'readPod')).toHaveLength(1);
    expect(kube.calls).not.toContain('createPod');
  });

  it('bounds every call with a context timeout', async () => {
    const kube = new FakeKube();
    kube.hang.add('readPod');
    const { driver } = harness({ kube });
    await expect(driver.create(spec())).rejects.toMatchObject({
      code: 'SBX_DRIVER_UNAVAILABLE',
    });
  });

  it('refuses a mount whose source is a host path, creating nothing', async () => {
    const { driver, kube } = harness();
    await expect(
      driver.create(
        spec({
          mounts: [{ kind: 'inputs', source: 'file:///srv/in', target: '/in', readOnly: true }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SBX_CONFIG_INVALID' });
    expect(kube.pods.size).toBe(0);
  });
});

describe('KubernetesDriver.create run-network gate (SANDBOX-005)', () => {
  it('is blocked, creating no Pod, when the run network is only partly applied', async () => {
    const kube = new FakeKube();
    const { driver } = harness({ kube });
    // Default-deny present, egress allow missing: the run has no egress, and create must not start.
    kube.netpols.delete(runPolicyNames(RUN).egress);
    await expect(driver.create(spec())).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
    expect(kube.pods.size).toBe(0);
  });

  it('is blocked when the run network is missing entirely', async () => {
    const kube = new FakeKube();
    const { driver } = harness({ kube });
    kube.netpols.clear();
    await expect(driver.create(spec())).rejects.toMatchObject({
      code: 'SBX_NETWORK_UNAVAILABLE',
    });
    expect(kube.pods.size).toBe(0);
  });

  it('refuses a run network that belongs to another tenant, creating nothing', async () => {
    const { driver, kube } = harness();
    await expect(driver.create(spec({ tenantId: OTHER_TENANT }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(kube.pods.size).toBe(0);
  });

  it('refuses a sandbox that is bound to a network other than its run network', async () => {
    const { driver, kube } = harness();
    await expect(
      driver.create(spec({ network: { runId: RUN, networkId: 'bw-run-someone-else' } })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(kube.pods.size).toBe(0);
  });

  it('refuses to create when no NetworkPolicy enforcer is declared (SBX_NETPOL_UNSUPPORTED)', async () => {
    const kube = new FakeKube();
    seedRunNetwork(kube);
    const driver = new KubernetesDriver({ api: kube, namespace: NS, callTimeoutMs: 50 });
    await expect(driver.create(spec())).rejects.toMatchObject({
      code: 'SBX_NETPOL_UNSUPPORTED',
    });
    expect(kube.pods.size).toBe(0);
  });
});

describe('KubernetesDriver hardening (SANDBOX-007)', () => {
  it('clamps requested resources to the plan ceiling, warns, and renders the clamped limits', async () => {
    const kube = new FakeKube();
    const warnings: Record<string, unknown>[] = [];
    const driver = new KubernetesDriver({
      api: kube,
      namespace: NS,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      netpolEnforcer: 'calico',
      logger: { warn: (fields) => warnings.push(fields) },
    });
    seedRunNetwork(kube);
    await driver.create(spec({ resources: { cpu: 0.5, memoryMiB: 16_384, pids: 128 } }));
    const pod = kube.pods.get(podName(SANDBOX));
    expect(pod?.spec?.containers[0]?.resources?.limits).toEqual({ cpu: '0.5', memory: '8192Mi' });
    expect(warnings).toEqual([
      expect.objectContaining({ field: 'memoryMiB', requested: 16_384, ceiling: 8192 }),
    ]);
  });

  it('renders the Pod with the SANDBOX-007 non-root uid and the bw-sandbox seccomp profile', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    const pod = kube.pods.get(podName(SANDBOX));
    expect(pod?.spec?.containers[0]?.securityContext).toMatchObject({
      runAsUser: 10_001,
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      privileged: false,
      seccompProfile: { type: 'Localhost', localhostProfile: 'bw-sandbox.json' },
    });
  });

  it('surfaces a container that cannot be created (for example a missing seccomp profile) as failed', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, {
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'sandbox',
          image: DIGEST,
          imageID: '',
          ready: false,
          restartCount: 0,
          state: { waiting: { reason: 'CreateContainerError' } },
        },
      ],
    });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unhealthy',
      reason: 'container failed to start: CreateContainerError',
    });
    await expect(driver.list({ tenantId: TENANT })).resolves.toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });
});

describe('KubernetesDriver.start', () => {
  it('removes the start gate exactly once and emits started', async () => {
    const { driver, kube, events } = harness();
    await driver.create(spec());
    await driver.start(SANDBOX);
    expect(kube.pods.get(podName(SANDBOX))?.spec?.schedulingGates).toEqual([]);
    await driver.start(SANDBOX);
    expect(kube.calls.filter((op) => op === 'replacePod')).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['created', 'started']);
  });

  it('rejects an unknown sandbox with NotFound', async () => {
    const { driver } = harness();
    await expect(driver.start(OTHER_SANDBOX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('KubernetesDriver.health', () => {
  it('reports healthy for a Running, Ready Pod', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
    });
    await expect(driver.health(SANDBOX)).resolves.toEqual({
      state: 'healthy',
      checkedAt: NOW.toISOString(),
    });
  });

  it('reports unknown for a Running Pod that is not Ready and for a Pending Pod', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unknown',
      reason: 'not ready',
    });
    kube.setStatus(SANDBOX, { phase: 'Pending' });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unknown',
      reason: 'not started',
    });
  });

  it('reports unhealthy for a Failed or exited Pod', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, { phase: 'Failed' });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unhealthy',
      reason: 'pod Failed',
    });
    kube.setStatus(SANDBOX, { phase: 'Succeeded' });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({ state: 'unhealthy' });
  });

  it('surfaces an image pull failure as unhealthy and emits one failed lifecycle event', async () => {
    const { driver, kube, events } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, {
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'sandbox',
          image: DIGEST,
          imageID: '',
          ready: false,
          restartCount: 0,
          state: { waiting: { reason: 'ImagePullBackOff' } },
        },
      ],
    });
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unhealthy',
      reason: 'container failed to start: ImagePullBackOff',
    });
    await driver.health(SANDBOX);
    expect(events.filter((e) => e.type === 'failed')).toEqual([
      expect.objectContaining({
        sandboxId: SANDBOX,
        reason: 'container failed to start: ImagePullBackOff',
      }),
    ]);
  });

  it('maps eviction and an OOM kill to a failed status in list', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, { phase: 'Failed', reason: 'Evicted' });
    await expect(driver.list({ tenantId: TENANT })).resolves.toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    kube.setStatus(SANDBOX, {
      phase: 'Failed',
      containerStatuses: [
        {
          name: 'sandbox',
          image: DIGEST,
          imageID: '',
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
        },
      ],
    });
    await expect(driver.list({ tenantId: TENANT })).resolves.toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('reports a terminating Pod as unhealthy and as stopped', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, { phase: 'Running' }, true);
    await expect(driver.health(SANDBOX)).resolves.toMatchObject({
      state: 'unhealthy',
      reason: 'pod is terminating',
    });
    await expect(driver.list({ tenantId: TENANT })).resolves.toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ]);
  });

  it('rejects an unknown sandbox with NotFound', async () => {
    const { driver } = harness();
    await expect(driver.health(OTHER_SANDBOX)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('KubernetesDriver.stop and destroy', () => {
  it('stop deletes with the requested grace period and emits stopped with the reason', async () => {
    const { driver, kube, events } = harness();
    await driver.create(spec());
    await driver.stop(SANDBOX, { graceSeconds: 30, reason: 'kill switch' });
    expect(kube.graceSeconds).toEqual([30]);
    expect(events.at(-1)).toMatchObject({ type: 'stopped', reason: 'kill switch' });
  });

  it('stop escalates a Pod that is already terminating to an immediate kill', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    kube.setStatus(SANDBOX, { phase: 'Running' }, true);
    await driver.stop(SANDBOX, { graceSeconds: 30 });
    expect(kube.graceSeconds).toEqual([0]);
  });

  it('stop on an absent sandbox resolves', async () => {
    const { driver } = harness();
    await expect(driver.stop(OTHER_SANDBOX, {})).resolves.toBeUndefined();
  });

  it('destroy deletes with gracePeriodSeconds 0 and emits destroyed', async () => {
    const { driver, kube, events } = harness();
    await driver.create(spec());
    await driver.destroy(SANDBOX);
    expect(kube.graceSeconds).toEqual([0]);
    expect(kube.pods.has(podName(SANDBOX))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'destroyed', runId: RUN });
  });

  it('destroy is idempotent: a second call on a gone Pod resolves', async () => {
    const { driver, kube } = harness();
    await driver.create(spec());
    await driver.destroy(SANDBOX);
    await expect(driver.destroy(SANDBOX)).resolves.toBeUndefined();
    expect(kube.graceSeconds).toEqual([0]);
  });
});

describe('KubernetesDriver.list', () => {
  it('filters by tenant and run labels and by status', async () => {
    const { driver, kube } = harness();
    await driver.ensureNetwork({
      runId: OTHER_RUN,
      tenantId: OTHER_TENANT,
      allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
      driver: 'kubernetes',
    });
    await driver.create(spec());
    await driver.create(
      spec({
        sandboxId: OTHER_SANDBOX,
        tenantId: OTHER_TENANT,
        runId: OTHER_RUN,
        network: { runId: OTHER_RUN, networkId: `bw-run-${OTHER_RUN}` },
      }),
    );
    const mine = await driver.list({ tenantId: TENANT });
    expect(mine.map((h) => h.sandboxId)).toEqual([SANDBOX]);
    expect((await driver.list({ tenantId: TENANT, runId: RUN })).map((h) => h.sandboxId)).toEqual([
      SANDBOX,
    ]);
    expect(await driver.list({ tenantId: TENANT, runId: OTHER_RUN })).toEqual([]);
    expect(await driver.list({ tenantId: TENANT, status: ['running'] })).toEqual([]);
    expect(kube.calls.filter((op) => op === 'listPods')).toHaveLength(4);
  });

  it('scopes the label selector to the tenant (§8.6)', async () => {
    const kube = new FakeKube();
    const selectors: string[] = [];
    const original = kube.listPods.bind(kube);
    kube.listPods = (namespace, selector) => {
      selectors.push(selector);
      return original(namespace, selector);
    };
    const { driver } = harness({ kube });
    await driver.list({ tenantId: TENANT });
    expect(selectors[0]).toContain(`${KUBE_LABEL.tenantId}=${TENANT}`);
    expect(selectors[0]).toContain(`${KUBE_LABEL.managedBy}=blackwing-sandbox-controller`);
  });
});

describe('KubernetesDriver.logs', () => {
  it('streams timestamped lines, reassembled across chunk boundaries and multibyte characters', async () => {
    const kube = new FakeKube();
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      '2026-10-20T10:00:01.000000000Z hello ünï\n2026-10-20T10:00:02Z bye\n',
    );
    const cut = 40; // splits the multibyte line mid-character
    kube.logChunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
    const { driver } = harness({ kube });
    await driver.create(spec());

    const lines = await collect(
      driver.logs(SANDBOX, { follow: true, tailLines: 5, since: '2026-10-20T10:00:00.000Z' }),
    );
    expect(lines).toEqual([
      { at: '2026-10-20T10:00:01.000Z', stream: 'stdout', line: 'hello ünï' },
      { at: '2026-10-20T10:00:02.000Z', stream: 'stdout', line: 'bye' },
    ]);
    expect(kube.logRequests).toEqual([
      { follow: true, tailLines: 5, sinceTime: '2026-10-20T10:00:00.000Z' },
    ]);
  });

  it('defaults to a non-follow stream and a fallback timestamp for unstamped lines', async () => {
    const kube = new FakeKube();
    kube.logChunks = [new TextEncoder().encode('no stamp here\r\n')];
    const { driver } = harness({ kube });
    await driver.create(spec());
    const lines = await collect(driver.logs(SANDBOX, {}));
    expect(lines).toEqual([{ at: NOW.toISOString(), stream: 'stdout', line: 'no stamp here' }]);
    expect(kube.logRequests).toEqual([{ follow: false }]);
  });

  it('rejects logs of an unknown sandbox with NotFound', async () => {
    const { driver } = harness();
    await expect(collect(driver.logs(OTHER_SANDBOX, {}))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects an invalid log option before any call', async () => {
    const { driver, kube } = harness();
    await expect(collect(driver.logs(SANDBOX, { tailLines: 0 }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(kube.calls).toEqual([]);
  });
});

describe('splitLogs', () => {
  it('flushes a trailing partial line without a newline', async () => {
    const chunks = Readable.from([new TextEncoder().encode('2026-10-20T10:00:03Z last')]);
    const lines = await collect(splitLogs(chunks, () => NOW.toISOString()));
    expect(lines).toEqual([{ at: '2026-10-20T10:00:03.000Z', stream: 'stdout', line: 'last' }]);
  });
});

describe('KubernetesDriver availability', () => {
  it('ping reports SBX_DRIVER_UNAVAILABLE when the API is unreachable', async () => {
    const kube = new FakeKube();
    for (let i = 0; i < 4; i += 1)
      kube.failures.push({ op: 'version', error: netError('ECONNREFUSED') });
    const { driver } = harness({ kube });
    await expect(driver.ping()).rejects.toMatchObject({ code: 'SBX_DRIVER_UNAVAILABLE' });
  });

  it('ping resolves when the API answers', async () => {
    const { driver } = harness();
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('ensureNetwork and removeNetwork delegate to the run-network provisioner (SANDBOX-005)', async () => {
    const { driver, kube } = harness();
    const port: SandboxDriver = driver;
    const runId = '01920000-0000-7000-8000-0000000000e1';
    const handle = await port.ensureNetwork({
      runId,
      tenantId: TENANT,
      allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
      driver: 'kubernetes',
    });
    expect(handle).toMatchObject({ runId, tenantId: TENANT, networkId: `bw-run-${runId}` });
    expect(kube.netpols.has(runPolicyNames(runId).defaultDeny)).toBe(true);
    await port.removeNetwork(runId);
    expect(kube.netpols.has(runPolicyNames(runId).egress)).toBe(false);
  });

  it('constructs lazily: no cluster is contacted until the first call, and close releases the client', async () => {
    const driver = new KubernetesDriver({ namespace: NS });
    await expect(driver.close()).resolves.toBeUndefined();
  });
});

describe('createDriver', () => {
  it('wires the KubernetesDriver for SBX_DRIVER=kubernetes in the configured namespace', () => {
    const driver = createDriver('kubernetes', { NODE_ENV: 'production', SBX_NAMESPACE: NS });
    expect(driver).toBeInstanceOf(KubernetesDriver);
    expect(driver.kind).toBe('kubernetes');
  });

  it('passes the declared enforcer and the audit and metric hooks through to the run network', async () => {
    const applies: string[] = [];
    const undeclared = createDriver(
      'kubernetes',
      { NODE_ENV: 'production', SBX_NAMESPACE: NS },
      { onNetpolApply: (result) => applies.push(result) },
    );
    await expect(
      undeclared.ensureNetwork({
        runId: RUN,
        tenantId: TENANT,
        allowedDestinations: [{ kind: 'egress-gateway', host: 'egress-gateway', port: 13128 }],
        driver: 'kubernetes',
      }),
    ).rejects.toMatchObject({ code: 'SBX_NETPOL_UNSUPPORTED' });
    expect(applies).toEqual(['unsupported']);
  });
});
