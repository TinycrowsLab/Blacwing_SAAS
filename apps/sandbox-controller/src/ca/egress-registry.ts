import type { RunScope } from '../drivers/types.js';

/**
 * What the egress gateway needs to MITM one run: the public certificate and its pinned fingerprint. It
 * never carries the private key (§8.7).
 */
export interface EgressCaPolicyEntry extends RunScope {
  readonly certificatePem: string;
  readonly fingerprintSha256: string;
  /** ISO-8601 UTC; the gateway stops intercepting for this run after it. */
  readonly notAfter: string;
}

/**
 * The control-plane port that hands a run CA to the egress gateway's per-run policy identity (EGRESS-006
 * consumes it). Publish and withdraw are idempotent per (tenant, run).
 */
export interface EgressCaRegistry {
  publish(entry: EgressCaPolicyEntry): Promise<void>;
  withdraw(scope: RunScope): Promise<void>;
}

/**
 * Process-local registry: the form the controller ships in this build. It keeps the same semantics the
 * control-plane port will have (keyed by tenant and run, so a run never resolves another tenant's CA).
 */
export interface InMemoryEgressCaRegistry extends EgressCaRegistry {
  lookup(scope: RunScope): EgressCaPolicyEntry | undefined;
}

export function createInMemoryEgressCaRegistry(): InMemoryEgressCaRegistry {
  const entries = new Map<string, EgressCaPolicyEntry>();
  const key = (scope: RunScope): string => `${scope.tenantId}/${scope.runId}`;
  return {
    publish(entry) {
      entries.set(key(entry), { ...entry });
      return Promise.resolve();
    },
    withdraw(scope) {
      entries.delete(key(scope));
      return Promise.resolve();
    },
    lookup(scope) {
      const entry = entries.get(key(scope));
      return entry === undefined ? undefined : { ...entry };
    },
  };
}
