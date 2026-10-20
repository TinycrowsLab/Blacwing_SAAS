import type { SandboxDriverKind } from '../config.js';

/**
 * Typed hook points later SANDBOX issues implement (SANDBOX-002+): drivers (KubernetesDriver,
 * DockerDriver), run networks and per-run CA material. Implementations must lazy-init their platform
 * client inside the methods, never at module top level, so the controller boots (and reports
 * `/readyz` 503) without one.
 */

/** Tenant and run every operation is scoped to (§8.6). */
export interface RunScope {
  readonly tenantId: string;
  readonly runId: string;
}

export interface SandboxCreateRequest extends RunScope {
  /** Caller-chosen id; creating twice with the same id must be idempotent (SANDBOX-010). */
  readonly sandboxId: string;
  /** Digest-pinned image (§8.9). */
  readonly imageDigest: string;
  readonly runtimeClass: string;
  readonly namespace: string;
  readonly ttlSeconds: number;
}

export interface SandboxHandle extends RunScope {
  readonly sandboxId: string;
  readonly driver: SandboxDriverKind;
}

export interface SandboxDriver {
  readonly kind: SandboxDriverKind;
  /** Resolves when the platform is reachable; rejects (SBX_DRIVER_UNAVAILABLE) otherwise. Feeds `/readyz`. */
  ping(): Promise<void>;
  create(request: SandboxCreateRequest): Promise<SandboxHandle>;
  destroy(scope: RunScope & { readonly sandboxId: string }): Promise<void>;
  /** Releases client resources on shutdown. */
  close(): Promise<void>;
}

/** Reference to a provisioned per-run network (Docker network / Kubernetes NetworkPolicy set). */
export interface RunNetworkRef extends RunScope {
  readonly networkId: string;
}

export interface NetworkProvisioner {
  ensureRunNetwork(scope: RunScope): Promise<RunNetworkRef>;
  releaseRunNetwork(scope: RunScope): Promise<void>;
}

/**
 * Per-run CA material. Only the public certificate and an opaque key reference cross this interface:
 * the private key never leaves the provisioner and is never logged (§8.7).
 */
export interface RunCaRef extends RunScope {
  readonly certificatePem: string;
  readonly keyRef: string;
}

export interface CaProvisioner {
  issueRunCa(scope: RunScope): Promise<RunCaRef>;
  revokeRunCa(scope: RunScope): Promise<void>;
}
