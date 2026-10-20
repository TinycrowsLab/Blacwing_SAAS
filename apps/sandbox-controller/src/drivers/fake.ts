import {
  type HealthStatus,
  type LogLine,
  type LogOptions,
  logOptionsSchema,
  type RunNetworkHandle,
  type RunNetworkSpec,
  runNetworkSpecSchema,
  type SandboxDriverKind,
  type SandboxHandle,
  type SandboxLifecycleEvent,
  type SandboxListFilter,
  sandboxListFilterSchema,
  type SandboxSpec,
  sandboxSpecSchema,
  type StopOptions,
  stopOptionsSchema,
} from '@blackwing/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { SbxDriverUnavailableError } from '../errors.js';

import type { SandboxDriver } from './driver.js';
import type { z } from 'zod';

export interface FakeDriverOptions {
  readonly kind?: SandboxDriverKind;
  /** Clock for `createdAt`/event timestamps; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Starts reachable (`ping` resolves) unless set to false. */
  readonly reachable?: boolean;
}

interface FakeSandbox {
  readonly spec: SandboxSpec;
  handle: SandboxHandle;
  readonly logs: LogLine[];
}

/**
 * In-memory `SandboxDriver` for controller unit tests (SANDBOX-002). It behaves like a real driver as far
 * as the contract goes: inputs are Zod-validated (fail closed), `create`/`ensureNetwork` are idempotent
 * by id, a sandbox needs its run network to exist first, and every transition emits a
 * `SandboxLifecycleEvent` into `events`. It never touches a container runtime.
 */
export class FakeDriver implements SandboxDriver {
  readonly kind: SandboxDriverKind;
  /** Flip to false to make `ping` (and every operation) reject with SBX_DRIVER_UNAVAILABLE. */
  reachable: boolean;
  readonly events: SandboxLifecycleEvent[] = [];

  private readonly now: () => Date;
  private readonly networks = new Map<string, { spec: RunNetworkSpec; handle: RunNetworkHandle }>();
  private readonly sandboxes = new Map<string, FakeSandbox>();
  private nextNativeId = 1;

  constructor(options: FakeDriverOptions = {}) {
    this.kind = options.kind ?? 'docker';
    this.reachable = options.reachable ?? true;
    this.now = options.now ?? (() => new Date());
  }

  ping(): Promise<void> {
    return this.guard(() => undefined);
  }

  ensureNetwork(spec: RunNetworkSpec): Promise<RunNetworkHandle> {
    return this.guard(() => {
      const parsed = parse(runNetworkSpecSchema, spec, 'run network spec');
      if (parsed.driver !== this.kind) {
        throw new ValidationError(`run network targets driver ${parsed.driver}, not ${this.kind}`);
      }
      const existing = this.networks.get(parsed.runId);
      if (existing !== undefined) {
        if (existing.spec.tenantId !== parsed.tenantId) {
          throw new ConflictError('run network belongs to another tenant');
        }
        return existing.handle;
      }
      const handle: RunNetworkHandle = {
        runId: parsed.runId,
        tenantId: parsed.tenantId,
        networkId: `bw-run-${parsed.runId}`,
        driver: this.kind,
        nativeId: this.nativeId('net'),
        createdAt: this.timestamp(),
      };
      this.networks.set(parsed.runId, { spec: parsed, handle });
      return handle;
    });
  }

  removeNetwork(runId: string): Promise<void> {
    return this.guard(() => {
      for (const sandbox of this.sandboxes.values()) {
        if (sandbox.spec.runId === runId && sandbox.handle.status !== 'destroyed') {
          throw new ConflictError('run network still has live sandboxes');
        }
      }
      this.networks.delete(runId);
    });
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    return this.guard(() => {
      const parsed = parse(sandboxSpecSchema, spec, 'sandbox spec');
      const existing = this.sandboxes.get(parsed.sandboxId);
      if (existing !== undefined) {
        if (existing.spec.tenantId !== parsed.tenantId || existing.spec.runId !== parsed.runId) {
          throw new ConflictError('sandbox id already used by another run');
        }
        return existing.handle;
      }
      const network = this.networks.get(parsed.runId);
      if (
        network?.spec.tenantId !== parsed.tenantId ||
        network.handle.networkId !== parsed.network.networkId
      ) {
        throw new ValidationError('sandbox network is not provisioned for this run');
      }
      const handle: SandboxHandle = {
        sandboxId: parsed.sandboxId,
        tenantId: parsed.tenantId,
        runId: parsed.runId,
        driver: this.kind,
        nativeId: this.nativeId('sbx'),
        status: 'created',
        ips: [],
        createdAt: this.timestamp(),
      };
      this.sandboxes.set(parsed.sandboxId, { spec: parsed, handle, logs: [] });
      this.emit(handle, 'created');
      return handle;
    });
  }

  start(sandboxId: string): Promise<void> {
    return this.guard(() => {
      const sandbox = this.get(sandboxId);
      if (sandbox.handle.status === 'running') {
        return;
      }
      if (sandbox.handle.status !== 'created') {
        throw new ConflictError(`cannot start a ${sandbox.handle.status} sandbox`);
      }
      sandbox.handle = { ...sandbox.handle, status: 'running', ips: [this.ip()] };
      this.emit(sandbox.handle, 'started');
    });
  }

  health(sandboxId: string): Promise<HealthStatus> {
    return this.guard(() => {
      const sandbox = this.get(sandboxId);
      const checkedAt = this.timestamp();
      if (sandbox.handle.status === 'running') {
        this.emit(sandbox.handle, 'healthy');
        return { state: 'healthy', checkedAt };
      }
      return { state: 'unhealthy', checkedAt, reason: `sandbox is ${sandbox.handle.status}` };
    });
  }

  async *logs(sandboxId: string, opts: LogOptions): AsyncIterable<LogLine> {
    const lines = await this.guard(() => {
      const parsed = parse(logOptionsSchema, opts, 'log options');
      const since = parsed.since === undefined ? undefined : Date.parse(parsed.since);
      const all = this.get(sandboxId).logs.filter(
        (line) => since === undefined || Date.parse(line.at) >= since,
      );
      return parsed.tailLines === undefined ? all : all.slice(-parsed.tailLines);
    });
    for (const line of lines) {
      yield line;
    }
  }

  stop(sandboxId: string, opts: StopOptions): Promise<void> {
    return this.guard(() => {
      const parsed = parse(stopOptionsSchema, opts, 'stop options');
      const sandbox = this.get(sandboxId);
      if (sandbox.handle.status !== 'created' && sandbox.handle.status !== 'running') {
        return;
      }
      sandbox.handle = { ...sandbox.handle, status: 'stopped', ips: [] };
      this.emit(sandbox.handle, 'stopped', parsed.reason);
    });
  }

  destroy(sandboxId: string): Promise<void> {
    return this.guard(() => {
      const sandbox = this.sandboxes.get(sandboxId);
      if (sandbox === undefined || sandbox.handle.status === 'destroyed') {
        return;
      }
      sandbox.handle = { ...sandbox.handle, status: 'destroyed', ips: [] };
      this.emit(sandbox.handle, 'destroyed');
    });
  }

  list(filter: SandboxListFilter): Promise<SandboxHandle[]> {
    return this.guard(() => {
      const parsed = parse(sandboxListFilterSchema, filter, 'list filter');
      return [...this.sandboxes.values()]
        .map((sandbox) => sandbox.handle)
        .filter(
          (handle) =>
            handle.tenantId === parsed.tenantId &&
            (parsed.runId === undefined || handle.runId === parsed.runId) &&
            (parsed.status === undefined || parsed.status.includes(handle.status)),
        );
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Test hook: append a log line as if the sandbox had written it. */
  appendLog(sandboxId: string, line: Omit<LogLine, 'at'> & { readonly at?: string }): void {
    this.get(sandboxId).logs.push({
      at: line.at ?? this.timestamp(),
      stream: line.stream,
      line: line.line,
    });
  }

  /** Test hook: mark a sandbox failed (e.g. OOM-killed) and emit the `failed` event. */
  fail(sandboxId: string, reason: string): void {
    const sandbox = this.get(sandboxId);
    sandbox.handle = { ...sandbox.handle, status: 'failed', ips: [] };
    this.emit(sandbox.handle, 'failed', reason);
  }

  private guard<T>(fn: () => T): Promise<T> {
    if (!this.reachable) {
      return Promise.reject(
        new SbxDriverUnavailableError(`${this.kind} fake driver is unreachable`),
      );
    }
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private get(sandboxId: string): FakeSandbox {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined || sandbox.handle.status === 'destroyed') {
      throw new NotFoundError('sandbox not found');
    }
    return sandbox;
  }

  private emit(handle: SandboxHandle, type: SandboxLifecycleEvent['type'], reason?: string): void {
    this.events.push({
      sandboxId: handle.sandboxId,
      runId: handle.runId,
      type,
      at: this.timestamp(),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private nativeId(prefix: string): string {
    const id = `${prefix}-${String(this.nextNativeId)}`;
    this.nextNativeId += 1;
    return id;
  }

  private ip(): string {
    return `10.0.0.${String(this.sandboxes.size + 1)}`;
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Paths and messages only, never the offending values (they may be env content).
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ValidationError(`invalid ${what}: ${issues.join('; ')}`);
  }
  return result.data;
}
