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
 * Inputs for issuing a run CA (SANDBOX-008). The window comes from the run plan; the standing
 * authorisation expiry caps the CA lifetime so no CA outlives the authority that allowed the run (§8.1).
 */
export interface IssueRunCaInput extends RunScope {
  /** ISO-8601 UTC end of the run window. */
  readonly runWindowEndsAt: string;
  /** ISO-8601 UTC expiry of the standing authorisation the run runs under. */
  readonly standingAuthorisationExpiresAt: string;
}

/**
 * Per-run CA material (SANDBOX-008). Only the public certificate, its fingerprint and opaque references
 * cross this interface: the private key stays in the secret store and is never returned or logged (§8.7).
 */
export interface RunCaRef extends RunScope {
  /** Public certificate PEM (CA:TRUE, pathlen 0). The only CA material a sandbox may see. */
  readonly certificatePem: string;
  /** `openbao://` reference to the stored private key. Used by the egress gateway, never by sandboxes. */
  readonly keyRef: string;
  /** `openbao://` reference to the stored public certificate; the value `SandboxSpec.caBundleRef` points at. */
  readonly caBundleRef: string;
  /** `sha256:<hex>` of the DER certificate, recorded on the run manifest for pinning (§8.9). */
  readonly fingerprintSha256: string;
  /** ISO-8601 UTC. `notBefore` is backdated for clock skew; `notAfter` is capped at the standing authorisation. */
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface CaProvisioner {
  /** Idempotent per run: a second call returns the CA already issued for that run (one CA per run). */
  issueRunCa(input: IssueRunCaInput): Promise<RunCaRef>;
  /** Deletes the run CA key and certificate and withdraws the run from the egress gateway. Idempotent. */
  revokeRunCa(scope: RunScope): Promise<void>;
}
