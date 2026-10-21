import type { PreflightCheckId, PreflightCheckStatus, PreflightReport } from './types.js';
import type {
  RunBudget,
  RunMode,
  RunState,
  StandingAuthorisationStatus,
} from '@blackwing/contracts';

/**
 * Ports the preflight checks depend on. Tenant data access (the `runs` and `assets` repositories), the
 * egress scope engine (EGRESS), the session manager, the notifications epic, the cost tracker and the
 * model gateway own the real adapters; each is a seam here so the checks are testable and fail closed.
 * A port that throws means "could not answer": the activity is retried, then the check fails.
 */

/** A registered asset the run targets. */
export interface PreflightAssetFact {
  readonly assetId: string;
  /** Host (or URL) to resolve and scope-check. Never contains credentials. */
  readonly target: string;
  readonly verification: 'unverified' | 'pending' | 'verified' | 'rejected';
}

/** One role the run logs in as. The credential is a reference into the secrets store (§8.7). */
export interface PreflightRoleFact {
  readonly role: string;
  readonly credentialRef: string;
}

/** Everything the gate checks read, loaded tenant-scoped (RLS) in one call. */
export interface PreflightRunFacts {
  readonly runId: string;
  readonly tenantId: string;
  readonly state: RunState;
  readonly mode: RunMode;
  /** Grey/white: the input manifest already supplies the attack surface (§3.2 note). */
  readonly manifestSuppliesSurface: boolean;
  readonly assets: readonly PreflightAssetFact[];
  readonly authorisation: {
    readonly id: string;
    readonly status: StandingAuthorisationStatus;
    readonly validFrom: string;
    readonly expiresAt: string;
    /** The signed attestation that the customer exempts the test accounts from lockout. */
    readonly lockoutExemptionAttested: boolean;
  };
  /** Current or next window occurrence resolved by the SA register; `null` = none is open (fail closed). */
  readonly window: { readonly opensAt: string; readonly closesAt: string } | null;
  readonly roles: readonly PreflightRoleFact[];
  /** What is left to spend, after the tenant's and the run's consumption. */
  readonly budgetsRemaining: RunBudget;
}

export interface PreflightRunRepo {
  /** `null` when the run does not exist for this tenant (RLS hides other tenants' runs). */
  load(tenantId: string, runId: string): Promise<PreflightRunFacts | null>;
  /** Idempotent: overwrites `runs.preflight_report` (jsonb) for the run. */
  saveReport(tenantId: string, runId: string, report: PreflightReport): Promise<void>;
}

export interface ResolvedTarget {
  readonly target: string;
  /** The egress scope engine's verdict for this target under the run's scope rules. */
  readonly inScope: boolean;
  /** False when DNS returned nothing. */
  readonly resolved: boolean;
  readonly addresses: readonly string[];
  /** True only when a scope rule explicitly admits private-range addresses for this target. */
  readonly privateAllowed: boolean;
}

/** EGRESS scope resolution (including the §8.2 anti-rebinding pre-check inputs). Sends no target traffic. */
export interface EgressScopeClient {
  resolve(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly targets: readonly string[];
  }): Promise<readonly ResolvedTarget[]>;
}

export type RoleLoginResult = { readonly ok: true } | { readonly ok: false };

/** Session manager: runs the role's login recipe with the credential by reference and discards the session. */
export interface SessionLoginClient {
  verifyLogin(request: {
    readonly tenantId: string;
    readonly runId: string;
    readonly role: string;
    readonly credentialRef: string;
  }): Promise<RoleLoginResult>;
}

/** `delivered` is a confirmed delivery; `queued` is merely enqueued and does not count. */
export type SocNoticeState = 'delivered' | 'queued' | 'failed';

/** Notifications: sends the SOC notice if not yet sent and reports its confirmed state. Idempotent per run. */
export interface SocNoticeClient {
  ensureDelivered(request: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<SocNoticeState>;
}

/** Model gateway reachability. Rejects when the provider cannot be reached. */
export interface ModelProviderProbe {
  ping(): Promise<void>;
}

/** An audit record before the ledger assigns its sequence number and hash (AUDIT-002). */
export interface PreflightAuditRecord {
  readonly action:
    'preflight.started' | 'preflight.check' | 'preflight.passed' | 'preflight.failed';
  readonly outcome: 'success' | 'failure';
  readonly tenantId: string;
  readonly runId: string;
  readonly occurredAt: string;
  /** Stable per run and event, so a retried activity cannot append a duplicate. */
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only audit writer (§8.8). A failure must surface so Temporal retries the activity. */
export interface PreflightAuditSink {
  append(record: PreflightAuditRecord): Promise<void>;
}

/** Metrics sink; the default implementation is OpenTelemetry. */
export interface PreflightMetrics {
  /** `blackwing_preflight_check_total{check,status}`. */
  checkResult(check: PreflightCheckId, status: PreflightCheckStatus): void;
  /** `blackwing_preflight_duration_seconds`. */
  duration(seconds: number): void;
}
