import type { RunNetworkHandle, RunNetworkSpec } from '@blackwing/contracts';

/**
 * Provisions the isolated network of one run (SANDBOX-005, CONTEXT_PACK §4.1). One run gets one network;
 * `ensureNetwork` is idempotent by `runId`, and every method fails closed: a network that cannot be proven
 * to isolate is an error, never a silent fallback to open egress.
 */
export interface NetworkProvisioner {
  /** Creates (or reconciles) the run network and returns its handle. Rejects when it cannot be applied. */
  ensureNetwork(spec: RunNetworkSpec): Promise<RunNetworkHandle>;
  /** Removes the run network. Resolves if it is already gone; refuses while sandboxes of the run still exist. */
  removeNetwork(runId: string): Promise<void>;
  /**
   * Rejects unless the run network exists and belongs to `tenantId`. Sandbox creation calls it, so a sandbox
   * can never start on a run whose network was not applied in full.
   */
  assertNetwork(runId: string, tenantId: string): Promise<void>;
}

/** Audit-visible run network transitions (`run_network.created` / `run_network.destroyed`). */
export interface RunNetworkEvent {
  readonly type: 'run_network.created' | 'run_network.destroyed';
  readonly runId: string;
  readonly tenantId: string;
  readonly at: string;
}
