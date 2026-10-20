/** Outcome of one dependency check. */
export type CheckStatus = 'ok' | 'down';

/** Roll-up of all checks: `degraded` means only non-critical dependencies are down. */
export type OverallStatus = 'ok' | 'degraded' | 'down';

/** Stable, secret-free failure codes. Raw driver errors can carry hosts or connection strings. */
export type CheckError = 'timeout' | 'unreachable';

/** A dependency the API relies on. `check` rejects when the dependency is unhealthy. */
export interface HealthProbe {
  readonly name: string;
  /** Critical probes decide `/health/ready`; non-critical ones only degrade `/health`. */
  readonly critical: boolean;
  check(signal: AbortSignal): Promise<void>;
}

export interface CheckResult {
  readonly status: CheckStatus;
  readonly latencyMs: number;
  readonly error?: CheckError;
}

export interface HealthReport {
  readonly status: OverallStatus;
  readonly checks: Readonly<Record<string, CheckResult>>;
  readonly version: string;
  readonly commit: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly report: HealthReport;
}
