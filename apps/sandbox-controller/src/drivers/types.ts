/**
 * Hook points beside the driver that later SANDBOX issues implement. The driver interface itself is
 * `./driver.ts`; its data contracts (`SandboxSpec`, `RunNetworkSpec`, `SandboxHandle`, ...) live in
 * `@blackwing/contracts`. Implementations must lazy-init their platform client inside the methods,
 * never at module top level, so the controller boots (and reports `/readyz` 503) without one.
 */

/** Tenant and run every operation is scoped to (§8.6). */
export interface RunScope {
  readonly tenantId: string;
  readonly runId: string;
}

/**
 * Per-run CA material (SANDBOX-008). Only the public certificate and an opaque key reference cross this
 * interface: the private key never leaves the provisioner and is never logged (§8.7).
 */
export interface RunCaRef extends RunScope {
  readonly certificatePem: string;
  readonly keyRef: string;
}

export interface CaProvisioner {
  issueRunCa(scope: RunScope): Promise<RunCaRef>;
  revokeRunCa(scope: RunScope): Promise<void>;
}
