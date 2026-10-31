// Policy decision log persistence (POLICY-004, CONTEXT_PACK §7, §8.6, §8.7). The PDP writes one row per logged
// decision through this repository, which implements the engine's `DecisionLogSink` port structurally (the
// policy package does not depend on db). Every write runs through `withTenant`, so RLS confines it to the
// decision's own tenant and a missing tenant context fails closed. Rows hold ids, decisions and a context digest
// only: the raw context is never stored.

import { desc, eq } from 'drizzle-orm';

import { policyDecisionLogs, type PolicyDecisionLogRow } from './schema/policy-decision-logs.js';
import { withTenant } from './with-tenant.js';

import type { Database } from './client.js';

/** One decision to persist. Shape matches the `DecisionLogEntry` of `@blackwing/policy`. */
export interface PolicyDecisionLogRecord {
  readonly tenantId: string;
  readonly runId: string | undefined;
  readonly action: string;
  readonly decision: 'allow' | 'deny';
  readonly determiningPolicyIds: readonly string[];
  readonly errored: boolean;
  readonly latencyMs: number;
  readonly contextDigest: string;
  readonly nowUtc: string;
}

/** A stored decision as the listing returns it. */
export type PolicyDecisionLogEntry = PolicyDecisionLogRow;

export interface PolicyDecisionLogRepositoryOptions {
  readonly db: Database;
}

export class PolicyDecisionLogRepository {
  constructor(private readonly options: PolicyDecisionLogRepositoryOptions) {}

  /** Appends one decision. Rejects a malformed row (the check constraints) rather than storing it. */
  async write(record: PolicyDecisionLogRecord): Promise<void> {
    await withTenant(this.options.db, record.tenantId, (tx) =>
      tx.insert(policyDecisionLogs).values({
        tenantId: record.tenantId,
        runId: record.runId ?? null,
        action: record.action,
        decision: record.decision,
        determiningPolicyIds: [...record.determiningPolicyIds],
        errored: record.errored,
        latencyMs: record.latencyMs,
        contextDigest: record.contextDigest,
        nowUtc: new Date(record.nowUtc),
      }),
    );
  }

  /** The tenant's most recent decisions, newest first. Bounded by `limit`. */
  async listRecent(tenantId: string, limit = 100): Promise<readonly PolicyDecisionLogEntry[]> {
    return withTenant(this.options.db, tenantId, (tx) =>
      tx
        .select()
        .from(policyDecisionLogs)
        .where(eq(policyDecisionLogs.tenantId, tenantId))
        .orderBy(desc(policyDecisionLogs.createdAt))
        .limit(limit),
    );
  }
}
