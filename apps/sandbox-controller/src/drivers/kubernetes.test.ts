import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SANDBOX_WORKSPACE_MIB } from '../config.js';
import { SbxDriverUnavailableError, SbxRuntimeMissingError } from '../errors.js';
import { createDriver } from './index.js';
import {
  KUBE_LABEL,
  podName,
  renderPod,
  RUNTIME_HANDLER,
  START_GATE,
} from './kubernetes-config.js';
import { KubernetesDriver, splitLogs } from './kubernetes.js';
import { BUILT_IN_HARDENING_CONFIG, buildKubernetesHardening } from '../spec/hardening.js';

import type { SandboxDriver } from './driver.js';
import type { KubeApi, KubeLogRequest } from './kubernetes-api.js';
import type { SandboxLifecycleEvent, SandboxSpec } from '@blackwing/contracts';
import type { V1Pod, V1RuntimeClass } from '@kubernetes/client-node';

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

/** An error shaped like client-node's ApiException (numeric `code`). */
const httpError = (code: number): Error =>
  Object.assign(new Error(`HTTP ${String(code)}`), { code });
const netError = (code: string): Error => Object.assign(new Error(code), { code });

class FakeKube implements KubeApi {
  readonly pods = new Map<string, V1Pod>();
  readonly runtimeClasses = new Map<string, V1RuntimeClass>([
    ['gvisor', { metadata: { name: 'gvisor' }, handler: RUNTIME_HANDLER }],
  ]);
  readonly calls: string[] = [];
  readonly graceSeconds: number[] = [];
  readonly logRequests: KubeLogRequest[] = [];
  logChunks: Uint8Array[] = [];
  /** Errors thrown by the next calls of an operation, in order. */
  readonly failures: { op: string; error: Error }[] = [];
  /** Operations that never settle (to exercise the context timeout). */
  readonly hang = new Set<string>();
  private uid = 0;

  private enter(op: string): Promise<void> | undefined {
    this.calls.push(op);
    const failure = this.failures.find((f) => f.op === op);
    if (failure !== undefined) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      return Promise.reject(failure.error);
    }
    if (this.hang.has(op)) return new Promise<void>(() => undefined);
    return undefined;
  }

  async version(): Promise<void> {
    const failed = this.enter('version');
    if (failed) await failed;
  }

  async readRuntimeClass(name: string): Promise<V1RuntimeClass | undefined> {
    const failed = this.enter('readRuntimeClass');
    if (failed) await failed;
    return this.runtimeClasses.get(name);
  }

  async createPod(namespace: string, pod: V1Pod): Promise<V1Pod> {
    const failed = this.enter('createPod');
    if (failed) await failed;
    const name = pod.metadata?.name ?? '';
    if (this.pods.has(name)) throw httpError(409);
    this.uid += 1;
    const stored = structuredClone(pod);
    stored.metadata ??= {};
    stored.metadata.namespace = namespace;
    stored.metadata.uid = `uid-${String(this.uid)}`;
    stored.metadata.creationTimestamp = NOW;
    stored.status = { phase: 'Pending' };
    this.pods.set(name, stored);
    return stored;
  }

  async readPod(_namespace: string, name: string): Promise<V1Pod | undefined> {
    const failed = this.enter('readPod');
    if (failed) await failed;
    return this.pods.get(name);
  }

  async replacePod(_namespace: string, pod: V1Pod): Promise<V1Pod> {
    const failed = this.enter('replacePod');
    if (failed) await failed;
    const name = pod.metadata?.name ?? '';
    this.pods.set(name, pod);
    return pod;
  }

  async listPods(_namespace: string, labelSelector: string): Promise<V1Pod[]> {
    const failed = this.enter('listPods');
    if (failed) await failed;
    const wanted = labelSelector.split(',').map((term) => term.split('='));
    return [...this.pods.values()].filter((pod) =>
      wanted.every(([key, value]) => pod.metadata?.labels?.[key ?? ''] === value),
    );
  }

  async deletePod(_namespace: string, name: string, graceSeconds: number): Promise<void> {
    const failed = this.enter('deletePod');
    if (failed) await failed;
    this.graceSeconds.push(graceSeconds);
    this.pods.delete(name);
  }

  async streamLogs(
    _namespace: string,
    _name: string,
    _container: string,
    request: KubeLogRequest,
  ): Promise<AsyncIterable<Uint8Array>> {
    const failed = this.enter('streamLogs');
    if (failed) await failed;
    this.logRequests.push(request);
    return Readable.from(this.logChunks);
  }

  /** Moves a stored Pod to a status the cluster would report. */
  setStatus(sandboxId: string, status: NonNullable<V1Pod['status']>, deleting = false): void {
    const pod = this.pods.get(podName(sandboxId));
    if (pod === undefined) throw new Error('no such pod');
    pod.status = status;
    if (deleting) {
      pod.metadata ??= {};
      pod.metadata.deletionTimestamp = NOW;
    }
  }
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

function harness(overrides: { kube?: FakeKube; events?: SandboxLifecycleEvent[] } = {}) {
  const kube = overrides.kube ?? new FakeKube();
  const events = overrides.events ?? [];
  const creates: string[] = [];
  const driver = new KubernetesDriver({
    api: kube,
    namespace: NS,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    random: () => 0,
    callTimeoutMs: 50,
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

describe('KubernetesDriver hardening (SANDBOX-007)', () => {
  it('clamps requested resources to the plan ceiling, warns, and renders the clamped limits', async () => {
    const kube = new FakeKube();
    const warnings: Record<string, unknown>[] = [];
    const driver = new KubernetesDriver({
      api: kube,
      namespace: NS,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      logger: { warn: (fields) => warnings.push(fields) },
    });
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
    await driver.create(spec());
    await driver.create(spec({ sandboxId: OTHER_SANDBOX, tenantId: OTHER_TENANT }));
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

  it('ensureNetwork and removeNetwork fail closed until SANDBOX-005 provisions run networks', async () => {
    const { driver } = harness();
    const port: SandboxDriver = driver;
    await expect(
      port.ensureNetwork({
        runId: RUN,
        tenantId: TENANT,
        allowedDestinations: [{ kind: 'egress-gateway', host: 'egress.local', port: 8443 }],
        driver: 'kubernetes',
      }),
    ).rejects.toBeInstanceOf(SbxDriverUnavailableError);
    await expect(port.removeNetwork(RUN)).rejects.toBeInstanceOf(SbxDriverUnavailableError);
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
});
