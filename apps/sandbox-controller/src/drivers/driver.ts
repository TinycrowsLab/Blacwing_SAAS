import type {
  HealthStatus,
  LogLine,
  LogOptions,
  RunNetworkHandle,
  RunNetworkSpec,
  SandboxDriverKind,
  SandboxHandle,
  SandboxListFilter,
  SandboxSpec,
  StopOptions,
} from '@blackwing/contracts';

/**
 * The one abstraction both sandbox drivers implement (SANDBOX-002): KubernetesDriver (SANDBOX-003) and
 * DockerDriver (SANDBOX-004) are swapped by `SBX_DRIVER` without touching call sites. All data crossing
 * it is the shared, Zod-validated contracts from `@blackwing/contracts`; no Kubernetes or Docker type
 * leaks into the interface.
 *
 * Rules every implementation follows:
 * - Lazy platform client: constructing a driver never touches Kubernetes/Docker, so the controller boots
 *   (and reports `/readyz` 503) without one.
 * - Fail closed: an invalid spec, unknown id or unreachable platform rejects; nothing is created.
 * - Idempotent by caller-chosen id: `ensureNetwork` per run, `create` per sandboxId; `stop`, `destroy`
 *   and `removeNetwork` on something already gone resolve.
 * - Scope (§8.6): every spec carries `tenantId`/`runId`; `list` always filters by tenant.
 */
export interface SandboxDriver {
  readonly kind: SandboxDriverKind;
  /** Resolves when the platform is reachable; rejects (SBX_DRIVER_UNAVAILABLE) otherwise. Feeds `/readyz`. */
  ping(): Promise<void>;
  /** Provisions (or returns) the isolated network of one run; one run gets one network (§4.1). */
  ensureNetwork(spec: RunNetworkSpec): Promise<RunNetworkHandle>;
  /** Removes the run network. Resolves if it is already gone. */
  removeNetwork(runId: string): Promise<void>;
  /** Creates (does not start) a sandbox; repeating the same `sandboxId` returns the same handle. */
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  start(sandboxId: string): Promise<void>;
  health(sandboxId: string): Promise<HealthStatus>;
  logs(sandboxId: string, opts: LogOptions): AsyncIterable<LogLine>;
  stop(sandboxId: string, opts: StopOptions): Promise<void>;
  /** Removes the sandbox and its workspace. Resolves if it is already gone. */
  destroy(sandboxId: string): Promise<void>;
  list(filter: SandboxListFilter): Promise<SandboxHandle[]>;
  /** Releases client resources on shutdown. */
  close(): Promise<void>;
}
