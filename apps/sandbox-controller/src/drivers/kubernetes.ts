import { StringDecoder } from 'node:string_decoder';

import {
  type HealthStatus,
  type LogLine,
  type LogOptions,
  logOptionsSchema,
  type RunNetworkHandle,
  type SandboxHandle,
  type SandboxLifecycleEvent,
  type SandboxListFilter,
  sandboxListFilterSchema,
  type SandboxSpec,
  type SandboxStatus,
  sandboxSpecSchema,
  type StopOptions,
  stopOptionsSchema,
} from '@blackwing/contracts';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { SbxDriverUnavailableError, SbxRuntimeMissingError } from '../errors.js';
import { MANAGED_BY } from './docker-config.js';
import { createKubeApi, type KubeApi, statusCodeOf } from './kubernetes-api.js';
import {
  CONTAINER_NAME,
  KUBE_LABEL,
  podName,
  renderPod,
  RUNTIME_HANDLER,
} from './kubernetes-config.js';
import {
  BUILT_IN_HARDENING_CONFIG,
  buildKubernetesHardening,
  type HardeningConfig,
  type HardeningOptions,
  resolveHardening,
} from '../spec/hardening.js';

import type { SandboxDriver } from './driver.js';
import type { V1Pod } from '@kubernetes/client-node';
import type { z } from 'zod';

const DEFAULT_NAMESPACE = 'bw-runs';
const DEFAULT_GRACE_SECONDS = 10;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2000;
const REASON_MAX = 1024;
const LOG_LINE_MAX = 65_536;
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
]);
/**
 * Container waiting reasons that mean the sandbox cannot start: an unpullable digest, or a container that
 * fails to create (for example a missing seccomp profile or secret). Surfaced as `failed`, never retried
 * into the default runtime.
 */
const START_FAILURE_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerError',
  'CreateContainerConfigError',
  'RunContainerError',
]);

export interface KubernetesDriverOptions {
  /** Kubernetes client; defaults to `@kubernetes/client-node`, created lazily on first use. */
  readonly api?: KubeApi;
  /** Namespace of every sandbox Pod (`SBX_NAMESPACE`). */
  readonly namespace?: string;
  readonly now?: () => Date;
  /** Lifecycle events (`created`, `started`, `stopped`, `destroyed`, `failed`) for audit. */
  readonly onEvent?: (event: SandboxLifecycleEvent) => void;
  /** `sbx_create_total{driver=kubernetes,result}` hook. */
  readonly onCreate?: (result: 'created' | 'existing' | 'failed') => void;
  /** Wait between retries; tests inject a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); tests inject a constant. */
  readonly random?: () => number;
  /** Context timeout for one Kubernetes API call. */
  readonly callTimeoutMs?: number;
  /** SANDBOX-007 defaults and plan ceiling; the shared hardening source of truth. */
  readonly hardening?: HardeningConfig;
  /** Receives a warning whenever a requested value is clamped to the plan ceiling. */
  readonly logger?: HardeningOptions['logger'];
}

/** A Kubernetes call that exceeded its context timeout. Transient, so it is retried. */
class KubeCallTimeoutError extends Error {
  constructor(ms: number) {
    super(`kubernetes API call exceeded ${String(ms)}ms`);
  }
}

/**
 * `SandboxDriver` over the Kubernetes API with the `runsc` RuntimeClass on k3s (staging and prod).
 * Lazy client (nothing touches the cluster at construction); fail closed; never falls back to the default
 * runtime; the RuntimeClass must resolve to the `runsc` handler before any Pod is created; creation is
 * idempotent by the deterministic Pod name and the `bw/sandbox-id` label; transient API failures retry
 * with capped, jittered backoff before surfacing as SBX_DRIVER_UNAVAILABLE.
 *
 * A Pod starts as soon as it is scheduled, so `create` renders it behind a scheduling gate and `start`
 * removes the gate. That keeps the same create-then-start contract as the Docker driver.
 */
export class KubernetesDriver implements SandboxDriver {
  readonly kind = 'kubernetes' as const;

  private readonly options: KubernetesDriverOptions;
  private readonly namespace: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly callTimeoutMs: number;
  private readonly hardening: HardeningConfig;
  private readonly verifiedRuntimeClasses = new Set<string>();
  private readonly reportedFailures = new Set<string>();
  private api: KubeApi | undefined;

  constructor(options: KubernetesDriverOptions = {}) {
    this.options = options;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.hardening = options.hardening ?? BUILT_IN_HARDENING_CONFIG;
  }

  private client(): KubeApi {
    this.api ??= this.options.api ?? createKubeApi();
    return this.api;
  }

  /**
   * Runs one API call with a context timeout. Transient failures (429, 5xx, timeout, unreachable) retry
   * with full-jitter backoff up to `MAX_ATTEMPTS`. Anything left is SBX_DRIVER_UNAVAILABLE, with no
   * response body in the message.
   */
  private async call<T>(fn: (api: KubeApi) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await withTimeout(fn(this.client()), this.callTimeoutMs);
      } catch (error) {
        if (attempt < MAX_ATTEMPTS && isTransient(error)) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw this.translate(error);
      }
    }
  }

  private backoffMs(attempt: number): number {
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    return Math.floor(this.random() * ceiling);
  }

  private translate(error: unknown): unknown {
    if (error instanceof AppError) return error;
    const status = statusCodeOf(error);
    const cause = error instanceof Error ? error : undefined;
    if (status !== undefined) {
      return new SbxDriverUnavailableError(
        `kubernetes API request failed (HTTP ${String(status)})`,
        {
          ...(cause === undefined ? {} : { cause }),
        },
      );
    }
    return new SbxDriverUnavailableError('kubernetes API request failed', {
      ...(cause === undefined ? {} : { cause }),
    });
  }

  async ping(): Promise<void> {
    await this.call((api) => api.version());
  }

  /** Verifies (and caches, positive results only) that the RuntimeClass exists and runs under `runsc`. */
  private async verifyRuntimeClass(name: string): Promise<void> {
    if (this.verifiedRuntimeClasses.has(name)) return;
    const runtimeClass = await this.call((api) => api.readRuntimeClass(name));
    if (runtimeClass === undefined) {
      throw new SbxRuntimeMissingError(
        `RuntimeClass ${name} is not defined on the cluster; refusing to create a sandbox`,
      );
    }
    if (runtimeClass.handler !== RUNTIME_HANDLER) {
      throw new SbxRuntimeMissingError(
        `RuntimeClass ${name} uses handler ${runtimeClass.handler}, not ${RUNTIME_HANDLER}; refusing to create a sandbox`,
      );
    }
    this.verifiedRuntimeClasses.add(name);
  }

  ensureNetwork(): Promise<RunNetworkHandle> {
    return Promise.reject(
      new SbxDriverUnavailableError('run network provisioning is owned by SANDBOX-005'),
    );
  }

  removeNetwork(): Promise<void> {
    return Promise.reject(
      new SbxDriverUnavailableError('run network provisioning is owned by SANDBOX-005'),
    );
  }

  async create(input: SandboxSpec): Promise<SandboxHandle> {
    const spec = parse(sandboxSpecSchema, input, 'sandbox spec');
    try {
      const existing = await this.readPod(spec.sandboxId);
      if (existing !== undefined) {
        assertTenant(existing, spec.tenantId);
        this.options.onCreate?.('existing');
        return this.toHandle(existing);
      }
      await this.verifyRuntimeClass(spec.runtimeClass);
      const request = { persona: spec.persona, resources: spec.resources };
      const resolved = resolveHardening(request, {
        config: this.hardening,
        ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      });
      const pod = renderPod(spec, {
        namespace: this.namespace,
        now: this.now(),
        hardening: buildKubernetesHardening(request, { config: this.hardening }),
        tmpfsCapMiB: resolved.workspaceMiB,
      });
      const created = await this.call(async (api) => {
        try {
          return await api.createPod(this.namespace, pod);
        } catch (error) {
          // A retried create can find its own earlier Pod: the deterministic name makes that a 409.
          if (statusCodeOf(error) !== HTTP_CONFLICT) throw error;
          const winner = await api.readPod(this.namespace, podName(spec.sandboxId));
          if (winner === undefined) throw error;
          return winner;
        }
      });
      assertTenant(created, spec.tenantId);
      this.options.onCreate?.('created');
      this.emit(spec.sandboxId, spec.runId, 'created');
      return this.toHandle(created);
    } catch (error) {
      this.options.onCreate?.('failed');
      this.emit(spec.sandboxId, spec.runId, 'failed', reasonOf(error));
      throw error;
    }
  }

  async start(sandboxId: string): Promise<void> {
    const pod = await this.requirePod(sandboxId);
    if ((pod.spec?.schedulingGates ?? []).length === 0) return; // already started
    const ungated = structuredClone(pod);
    if (ungated.spec !== undefined) ungated.spec.schedulingGates = [];
    await this.call((api) => api.replacePod(this.namespace, ungated));
    this.emit(sandboxId, runIdOf(pod), 'started');
  }

  async health(sandboxId: string): Promise<HealthStatus> {
    const pod = await this.requirePod(sandboxId);
    const checkedAt = this.now().toISOString();
    const failure = startFailureOf(pod);
    if (failure !== undefined && !this.reportedFailures.has(sandboxId)) {
      this.reportedFailures.add(sandboxId);
      this.emit(sandboxId, runIdOf(pod), 'failed', `container failed to start: ${failure}`);
    }
    return healthOf(pod, checkedAt);
  }

  async *logs(sandboxId: string, rawOpts: LogOptions): AsyncIterable<LogLine> {
    const opts = parse(logOptionsSchema, rawOpts, 'log options');
    await this.requirePod(sandboxId);
    const stream = await this.call((api) =>
      api.streamLogs(this.namespace, podName(sandboxId), CONTAINER_NAME, {
        follow: opts.follow === true,
        tailLines: opts.tailLines,
        sinceTime: opts.since,
      }),
    );
    yield* splitLogs(stream, () => this.now().toISOString());
  }

  async stop(sandboxId: string, rawOpts: StopOptions): Promise<void> {
    const opts = parse(stopOptionsSchema, rawOpts, 'stop options');
    const pod = await this.readPod(sandboxId);
    if (pod === undefined) return;
    // A Pod already terminating is escalated to an immediate kill, so a stuck Terminating Pod is cleared.
    const terminating = pod.metadata?.deletionTimestamp !== undefined;
    const grace = terminating ? 0 : (opts.graceSeconds ?? DEFAULT_GRACE_SECONDS);
    await this.call((api) => api.deletePod(this.namespace, podName(sandboxId), grace));
    this.emit(sandboxId, runIdOf(pod), 'stopped', opts.reason);
  }

  async destroy(sandboxId: string): Promise<void> {
    const pod = await this.readPod(sandboxId);
    if (pod === undefined) return;
    await this.call((api) => api.deletePod(this.namespace, podName(sandboxId), 0));
    this.emit(sandboxId, runIdOf(pod), 'destroyed');
  }

  async list(rawFilter: SandboxListFilter): Promise<SandboxHandle[]> {
    const filter = parse(sandboxListFilterSchema, rawFilter, 'list filter');
    const selector = [
      `${KUBE_LABEL.managedBy}=${MANAGED_BY}`,
      `${KUBE_LABEL.tenantId}=${filter.tenantId}`,
      ...(filter.runId === undefined ? [] : [`${KUBE_LABEL.runId}=${filter.runId}`]),
    ].join(',');
    const pods = await this.call((api) => api.listPods(this.namespace, selector));
    return pods
      .map((pod) => this.toHandle(pod))
      .filter((handle) => filter.status === undefined || filter.status.includes(handle.status));
  }

  close(): Promise<void> {
    this.api = undefined;
    return Promise.resolve();
  }

  private readPod(sandboxId: string): Promise<V1Pod | undefined> {
    return this.call((api) => api.readPod(this.namespace, podName(sandboxId)));
  }

  private async requirePod(sandboxId: string): Promise<V1Pod> {
    const pod = await this.readPod(sandboxId);
    if (pod === undefined) throw new NotFoundError(`sandbox ${sandboxId} not found`);
    return pod;
  }

  private toHandle(pod: V1Pod): SandboxHandle {
    const labels = pod.metadata?.labels ?? {};
    const createdAt = pod.metadata?.creationTimestamp ?? this.now();
    const ip = pod.status?.podIP;
    return {
      sandboxId: labels[KUBE_LABEL.sandboxId] ?? '',
      tenantId: labels[KUBE_LABEL.tenantId] ?? '',
      runId: labels[KUBE_LABEL.runId] ?? '',
      driver: 'kubernetes',
      nativeId: pod.metadata?.uid ?? pod.metadata?.name ?? '',
      status: statusOfPod(pod),
      ips: ip === undefined || ip === '' ? [] : [ip],
      createdAt: new Date(createdAt).toISOString(),
    };
  }

  private emit(
    sandboxId: string,
    runId: string,
    type: SandboxLifecycleEvent['type'],
    reason?: string,
  ): void {
    if (this.options.onEvent === undefined || runId === '') return;
    this.options.onEvent({
      sandboxId,
      runId,
      type,
      at: this.now().toISOString(),
      ...(reason !== undefined ? { reason: reason.slice(0, REASON_MAX) } : {}),
    });
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof KubeCallTimeoutError) return true;
  const status = statusCodeOf(error);
  if (status !== undefined) {
    return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR;
  }
  if (error instanceof Error && 'code' in error) {
    return typeof error.code === 'string' && UNREACHABLE_CODES.has(error.code);
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new KubeCallTimeoutError(ms));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function assertTenant(pod: V1Pod, tenantId: string): void {
  if (pod.metadata?.labels?.[KUBE_LABEL.tenantId] !== tenantId) {
    throw new ConflictError('sandbox id belongs to another tenant');
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'sandbox create failed';
}

function runIdOf(pod: V1Pod): string {
  return pod.metadata?.labels?.[KUBE_LABEL.runId] ?? '';
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`invalid ${what}: ${result.error.issues[0]?.message ?? 'rejected'}`);
  }
  return result.data;
}

/** The start-failure reason that makes a Pod `failed`, if any. */
function startFailureOf(pod: V1Pod): string | undefined {
  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting?.reason;
    if (waiting !== undefined && START_FAILURE_REASONS.has(waiting)) return waiting;
  }
  return undefined;
}

/** Pod phase, eviction, OOM and start failures -> sandbox status. Fail closed on unknown phases. */
function statusOfPod(pod: V1Pod): SandboxStatus {
  const phase = pod.status?.phase;
  if (pod.status?.reason === 'Evicted') return 'failed';
  if (startFailureOf(pod) !== undefined) return 'failed';
  const oom = (pod.status?.containerStatuses ?? []).some(
    (status) => status.state?.terminated?.reason === 'OOMKilled',
  );
  if (oom) return 'failed';
  if (pod.metadata?.deletionTimestamp !== undefined && phase !== 'Failed') return 'stopped';
  switch (phase) {
    case undefined:
    case 'Pending':
      return 'created';
    case 'Running':
      return 'running';
    case 'Succeeded':
      return 'stopped';
    default:
      return 'failed';
  }
}

/** Pod phase and the Ready condition -> health. */
function healthOf(pod: V1Pod, checkedAt: string): HealthStatus {
  if (pod.metadata?.deletionTimestamp !== undefined) {
    return { state: 'unhealthy', checkedAt, reason: 'pod is terminating' };
  }
  const failure = startFailureOf(pod);
  if (failure !== undefined) {
    return { state: 'unhealthy', checkedAt, reason: `container failed to start: ${failure}` };
  }
  const phase = pod.status?.phase;
  switch (phase) {
    case undefined:
    case 'Pending':
      return { state: 'unknown', checkedAt, reason: 'not started' };
    case 'Running': {
      const ready = (pod.status?.conditions ?? []).some(
        (condition) => condition.type === 'Ready' && condition.status === 'True',
      );
      return ready
        ? { state: 'healthy', checkedAt }
        : { state: 'unknown', checkedAt, reason: 'not ready' };
    }
    case 'Succeeded':
      return { state: 'unhealthy', checkedAt, reason: 'pod succeeded (exited)' };
    default:
      return { state: 'unhealthy', checkedAt, reason: `pod ${phase}` };
  }
}

/**
 * Splits timestamped Kubernetes log bytes into lines. A line is `<RFC3339Nano> <message>`. Kubernetes
 * merges stdout and stderr into one stream, so every line is reported as stdout.
 */
export async function* splitLogs(
  chunks: AsyncIterable<Uint8Array>,
  fallbackNow: () => string,
): AsyncIterable<LogLine> {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const toLine = (raw: string): LogLine => {
    const space = raw.indexOf(' ');
    const stamp = space > 0 ? raw.slice(0, space) : '';
    const parsed = stamp === '' ? Number.NaN : Date.parse(stamp);
    const hasStamp = !Number.isNaN(parsed);
    return {
      at: hasStamp ? new Date(parsed).toISOString() : fallbackNow(),
      stream: 'stdout',
      line: (hasStamp ? raw.slice(space + 1) : raw).slice(0, LOG_LINE_MAX),
    };
  };
  for await (const chunk of chunks) {
    const lines = (partial + decoder.write(Buffer.from(chunk))).split('\n');
    partial = lines.pop() ?? '';
    for (const raw of lines) yield toLine(raw.replace(/\r$/, ''));
  }
  partial += decoder.end();
  if (partial !== '') yield toLine(partial.replace(/\r$/, ''));
}
