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

import {
  SbxDriverUnavailableError,
  SbxImageMissingError,
  SbxRuntimeMissingError,
} from '../errors.js';
import { createDockerodeApi, type DockerApi, type DockerInspect, statusOf } from './docker-api.js';
import {
  LABEL,
  MANAGED_BY,
  renderContainerConfig,
  resolveFileMountSource,
} from './docker-config.js';

import type { SandboxDriver } from './driver.js';
import type { z } from 'zod';

const DEFAULT_RUNTIME = 'runsc';
const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const MS_PER_SECOND = 1000;
const REASON_MAX = 1024;
const SIGKILL_EXIT_CODE = 137;
const LOG_LINE_MAX = 65_536;
const FRAME_HEADER_BYTES = 8;
const FRAME_SIZE_OFFSET = 4;
const DEFAULT_GRACE_SECONDS = 10;
const DEFAULT_SOCKET = '/var/run/docker.sock';
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'ECONNRESET']);

export interface DockerDriverOptions {
  /** Engine client; defaults to dockerode on `socketPath`, created lazily on first use. */
  readonly api?: DockerApi;
  readonly socketPath?: string;
  /**
   * OCI runtime. Defaults to `runsc` (gVisor). Anything else (`runc`) is accepted only together with
   * `allowInsecureRuntime`, which the caller derives from `BW_ENV=dev|test`; it is never a fallback.
   */
  readonly runtime?: string;
  readonly allowInsecureRuntime?: boolean;
  /** Pull a digest-pinned image that is absent locally. Off by default. */
  readonly pullMissingImages?: boolean;
  /** Seccomp profile JSON (SANDBOX-007); when absent the engine default profile applies. */
  readonly seccompProfile?: string;
  readonly resolveMountSource?: (ref: string) => string;
  readonly now?: () => Date;
  /** Lifecycle events (`created`, `started`, `stopped`, `destroyed`, `failed`) for audit. */
  readonly onEvent?: (event: SandboxLifecycleEvent) => void;
  /** `sbx_create_total{driver=docker,result}` hook. */
  readonly onCreate?: (result: 'created' | 'existing' | 'failed') => void;
}

/**
 * `SandboxDriver` over the Docker Engine API with the `runsc` runtime (dev and future on-prem).
 * Lazy client (nothing touches Docker at construction); fail closed; never `runc` unless explicitly
 * allowed for dev/test; the Docker socket is never mounted into a sandbox (`renderContainerConfig`
 * asserts it); idempotent create keyed by the `bw.sandbox-id` label.
 */
export class DockerDriver implements SandboxDriver {
  readonly kind = 'docker' as const;

  private readonly options: DockerDriverOptions;
  private readonly runtime: string;
  private readonly now: () => Date;
  private api: DockerApi | undefined;
  private runtimeVerified = false;

  constructor(options: DockerDriverOptions = {}) {
    this.options = options;
    this.runtime = options.runtime ?? DEFAULT_RUNTIME;
    this.now = options.now ?? (() => new Date());
    if (this.runtime !== DEFAULT_RUNTIME && options.allowInsecureRuntime !== true) {
      throw new SbxRuntimeMissingError(
        `runtime ${this.runtime} is not permitted outside dev/test; only ${DEFAULT_RUNTIME} is allowed`,
      );
    }
  }

  private client(): DockerApi {
    this.api ??= this.options.api ?? createDockerodeApi(this.options.socketPath ?? DEFAULT_SOCKET);
    return this.api;
  }

  /** Runs an engine call; transport failures become SBX_DRIVER_UNAVAILABLE (fail closed). */
  private async call<T>(fn: (api: DockerApi) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client());
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    if (error instanceof AppError) return error;
    if (error instanceof Error && 'code' in error && isUnreachable(error.code)) {
      return new SbxDriverUnavailableError('docker daemon is unreachable', { cause: error });
    }
    if (statusOf(error) === undefined && error instanceof Error) {
      return new SbxDriverUnavailableError('docker daemon request failed', { cause: error });
    }
    return error;
  }

  async ping(): Promise<void> {
    await this.call((api) => api.ping());
  }

  /** Verifies (and caches) that the daemon has the configured runtime registered. */
  private async verifyRuntime(api: DockerApi): Promise<void> {
    if (this.runtimeVerified) return;
    const runtimes = await api.runtimes();
    if (!runtimes.includes(this.runtime)) {
      throw new SbxRuntimeMissingError(
        `docker daemon has no ${this.runtime} runtime registered; refusing to create a sandbox`,
      );
    }
    this.runtimeVerified = true;
  }

  ensureNetwork(): Promise<RunNetworkHandle> {
    return Promise.reject(
      new SbxDriverUnavailableError('run network provisioning is owned by SANDBOX-006'),
    );
  }

  removeNetwork(): Promise<void> {
    return Promise.reject(
      new SbxDriverUnavailableError('run network provisioning is owned by SANDBOX-006'),
    );
  }

  async create(input: SandboxSpec): Promise<SandboxHandle> {
    const spec = parse(sandboxSpecSchema, input, 'sandbox spec');
    try {
      const handle = await this.call(async (api) => {
        const existing = await api.findByLabels([`${LABEL.sandboxId}=${spec.sandboxId}`]);
        const existingId = existing[0];
        if (existingId !== undefined) {
          const inspected = await api.inspect(existingId);
          if (inspected.Config.Labels?.[LABEL.tenantId] !== spec.tenantId) {
            throw new ConflictError('sandbox id belongs to another tenant');
          }
          this.options.onCreate?.('existing');
          return toHandle(inspected);
        }
        await this.verifyRuntime(api);
        const config = renderContainerConfig(spec, {
          runtime: this.runtime,
          seccompProfile: this.options.seccompProfile,
          now: this.now(),
          resolveMountSource: this.options.resolveMountSource ?? resolveFileMountSource,
        });
        if (!(await api.imageExists(spec.imageDigest))) {
          if (this.options.pullMissingImages !== true) {
            throw new SbxImageMissingError(
              `image ${spec.imageDigest} is not present locally and pulling is disabled`,
            );
          }
          await api.pullImage(spec.imageDigest);
        }
        const id = await api.createContainer(config);
        this.options.onCreate?.('created');
        this.emit(spec.sandboxId, spec.runId, 'created');
        return toHandle(await api.inspect(id));
      });
      return handle;
    } catch (error) {
      this.options.onCreate?.('failed');
      this.emit(spec.sandboxId, spec.runId, 'failed', reasonOf(error));
      throw error;
    }
  }

  async start(sandboxId: string): Promise<void> {
    await this.call(async (api) => {
      const id = await this.requireId(api, sandboxId);
      try {
        await api.start(id);
      } catch (error) {
        if (statusOf(error) === HTTP_NOT_MODIFIED) return; // already started
        throw error;
      }
      const inspected = await api.inspect(id);
      this.emit(sandboxId, runIdOf(inspected), 'started');
    });
  }

  async health(sandboxId: string): Promise<HealthStatus> {
    return this.call(async (api) => {
      const inspected = await api.inspect(await this.requireId(api, sandboxId));
      return healthOf(inspected, this.now());
    });
  }

  async *logs(sandboxId: string, rawOpts: LogOptions): AsyncIterable<LogLine> {
    const opts = parse(logOptionsSchema, rawOpts, 'log options');
    const api = this.client();
    let stream: AsyncIterable<Uint8Array>;
    try {
      const id = await this.requireId(api, sandboxId);
      stream = await api.logs(id, {
        follow: opts.follow === true,
        tail: opts.tailLines,
        since:
          opts.since === undefined ? undefined : Math.floor(Date.parse(opts.since) / MS_PER_SECOND),
      });
    } catch (error) {
      throw this.translate(error);
    }
    yield* demuxLogs(stream, () => this.now().toISOString());
  }

  async stop(sandboxId: string, rawOpts: StopOptions): Promise<void> {
    const opts = parse(stopOptionsSchema, rawOpts, 'stop options');
    await this.call(async (api) => {
      const id = await this.findId(api, sandboxId);
      if (id === undefined) return;
      const grace = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS;
      try {
        if (grace === 0) await api.kill(id);
        else await api.stop(id, grace);
      } catch (error) {
        const status = statusOf(error);
        // 304 already stopped; 404 gone; 409 not running (kill on a stopped container).
        if (status === HTTP_NOT_MODIFIED || status === HTTP_NOT_FOUND || status === HTTP_CONFLICT)
          return;
        throw error;
      }
      const inspected = await api.inspect(id).catch(() => undefined);
      this.emit(
        sandboxId,
        inspected === undefined ? '' : runIdOf(inspected),
        'stopped',
        opts.reason,
      );
    });
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.call(async (api) => {
      const id = await this.findId(api, sandboxId);
      if (id === undefined) return;
      let runId = '';
      try {
        runId = runIdOf(await api.inspect(id));
        await api.remove(id);
      } catch (error) {
        if (statusOf(error) === HTTP_NOT_FOUND) return;
        throw error;
      }
      this.emit(sandboxId, runId, 'destroyed');
    });
  }

  async list(rawFilter: SandboxListFilter): Promise<SandboxHandle[]> {
    const filter = parse(sandboxListFilterSchema, rawFilter, 'list filter');
    return this.call(async (api) => {
      const labels = [`${LABEL.managedBy}=${MANAGED_BY}`, `${LABEL.tenantId}=${filter.tenantId}`];
      if (filter.runId !== undefined) labels.push(`${LABEL.runId}=${filter.runId}`);
      const ids = await api.findByLabels(labels);
      const handles: SandboxHandle[] = [];
      for (const id of ids) {
        try {
          const handle = toHandle(await api.inspect(id));
          if (filter.status === undefined || filter.status.includes(handle.status)) {
            handles.push(handle);
          }
        } catch (error) {
          if (statusOf(error) !== HTTP_NOT_FOUND) throw error;
        }
      }
      return handles;
    });
  }

  close(): Promise<void> {
    this.api?.close();
    this.api = undefined;
    return Promise.resolve();
  }

  private async findId(api: DockerApi, sandboxId: string): Promise<string | undefined> {
    const ids = await api.findByLabels([`${LABEL.sandboxId}=${sandboxId}`]);
    return ids[0];
  }

  private async requireId(api: DockerApi, sandboxId: string): Promise<string> {
    const id = await this.findId(api, sandboxId);
    if (id === undefined) throw new NotFoundError(`sandbox ${sandboxId} not found`);
    return id;
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

function isUnreachable(code: unknown): boolean {
  return typeof code === 'string' && UNREACHABLE_CODES.has(code);
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'sandbox create failed';
}

function runIdOf(inspected: DockerInspect): string {
  return inspected.Config.Labels?.[LABEL.runId] ?? '';
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`invalid ${what}: ${result.error.issues[0]?.message ?? 'rejected'}`);
  }
  return result.data;
}

/** Container state -> sandbox status. An OOM kill is `failed`; other exits are `stopped`. */
function statusOfContainer(inspected: DockerInspect): SandboxStatus {
  const { State: state } = inspected;
  if (state.OOMKilled === true) return 'failed';
  switch (state.Status) {
    case 'created':
      return 'created';
    case 'running':
    case 'restarting':
    case 'paused':
      return 'running';
    case 'exited':
    case 'removing':
      return 'stopped';
    default:
      return 'failed';
  }
}

function toHandle(inspected: DockerInspect): SandboxHandle {
  const labels = inspected.Config.Labels ?? {};
  const ips: string[] = [];
  for (const net of Object.values(inspected.NetworkSettings?.Networks ?? {})) {
    if (net.IPAddress) ips.push(net.IPAddress);
    if (net.GlobalIPv6Address) ips.push(net.GlobalIPv6Address);
  }
  return {
    sandboxId: labels[LABEL.sandboxId] ?? '',
    tenantId: labels[LABEL.tenantId] ?? '',
    runId: labels[LABEL.runId] ?? '',
    driver: 'docker',
    nativeId: inspected.Id,
    status: statusOfContainer(inspected),
    ips,
    createdAt: new Date(inspected.Created).toISOString(),
  };
}

function healthOf(inspected: DockerInspect, at: Date): HealthStatus {
  const checkedAt = at.toISOString();
  const { State: state } = inspected;
  if (state.OOMKilled === true) {
    return {
      state: 'unhealthy',
      checkedAt,
      reason: `container was OOM-killed (exit code ${String(state.ExitCode ?? SIGKILL_EXIT_CODE)})`,
    };
  }
  if (state.Running !== true) {
    if (state.Status === 'created') return { state: 'unknown', checkedAt, reason: 'not started' };
    return {
      state: 'unhealthy',
      checkedAt,
      reason: `container ${state.Status} (exit code ${String(state.ExitCode ?? 0)})`,
    };
  }
  const health = state.Health?.Status;
  if (health === undefined || health === 'none') return { state: 'healthy', checkedAt };
  if (health === 'healthy') return { state: 'healthy', checkedAt };
  if (health === 'unhealthy') {
    return { state: 'unhealthy', checkedAt, reason: 'HEALTHCHECK failing' };
  }
  return { state: 'unknown', checkedAt, reason: `HEALTHCHECK ${health}` };
}

/** Demultiplexes Docker's 8-byte-framed log stream into timestamped lines. */
export async function* demuxLogs(
  chunks: AsyncIterable<Uint8Array>,
  fallbackNow: () => string,
): AsyncIterable<LogLine> {
  let buffer = Buffer.alloc(0);
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const toLine = (stream: 'stdout' | 'stderr', raw: string): LogLine => {
    const space = raw.indexOf(' ');
    const stamp = space > 0 ? raw.slice(0, space) : '';
    const at = stamp !== '' && !Number.isNaN(Date.parse(stamp)) ? stamp : undefined;
    return {
      at: at === undefined ? fallbackNow() : new Date(at).toISOString(),
      stream,
      line: (at === undefined ? raw : raw.slice(space + 1)).slice(0, LOG_LINE_MAX),
    };
  };
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= FRAME_HEADER_BYTES) {
      const size = buffer.readUInt32BE(FRAME_SIZE_OFFSET);
      if (buffer.length < FRAME_HEADER_BYTES + size) break;
      const stream = buffer[0] === 2 ? 'stderr' : 'stdout';
      const text =
        partial[stream] +
        buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size).toString('utf8');
      buffer = buffer.subarray(FRAME_HEADER_BYTES + size);
      const lines = text.split('\n');
      partial[stream] = lines.pop() ?? '';
      for (const raw of lines) yield toLine(stream, raw.replace(/\r$/, ''));
    }
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    if (partial[stream] !== '') yield toLine(stream, partial[stream]);
  }
}
