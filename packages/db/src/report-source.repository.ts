// Tenant-scoped reads for the report model (REPORT-001, CONTEXT_PACK §3.2, §7, §8.6). Every read of one report runs in
// one `withTenant` transaction, so the report is a single snapshot even when it pages. The query shapes live here;
// the model, its ordering rules and its narrative mapping live in `@blackwing/reporting`.

import { and, eq, gt, sql } from 'drizzle-orm';

import { coverageManifests, type CoverageManifestRow } from './schema/coverage-manifests.js';
import { findingOccurrences, findings } from './schema/findings.js';
import { runs } from './schema/runs.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { EvidenceChainRef } from '@blackwing/contracts';

/** A run's identity row, as the report reads it. `publicId` and `manifest` are null until ORCH sets them. */
export interface ReportRunRow {
  readonly id: string;
  readonly publicId: string | null;
  readonly manifest: Record<string, unknown> | null;
}

/** One row of `findings`. */
type FindingRow = typeof findings.$inferSelect;

/** A released finding and the evidence references its occurrence in this run bound (references only, never bytes). */
export interface ReportFindingRow {
  readonly finding: FindingRow;
  readonly evidenceRefs: EvidenceChainRef[];
  /** `-(severity score)`, with a missing score ranked last (`-1`): the first sort key, ascending. */
  readonly severityRank: number;
}

/** Keyset position of the released-findings order: severity (highest first), then class, then public id. */
export interface ReleasedCursor {
  readonly severityRank: number;
  readonly class: string;
  readonly publicId: string;
}

/** Keyset position of the accepted-risk order: public id. */
export interface AcceptedRiskCursor {
  readonly publicId: string;
}

/** The reads one report needs. Only ever handed out inside `withReportSource`, so every call shares one snapshot. */
export interface ReportSource {
  readonly run: (runId: string) => Promise<ReportRunRow | undefined>;
  readonly coverage: (runId: string) => Promise<CoverageManifestRow | undefined>;
  /** Released findings seen in the run, after the cursor, in report order. Status is exactly `released`. */
  readonly releasedFindings: (
    runId: string,
    after: ReleasedCursor | null,
    limit: number,
  ) => Promise<ReportFindingRow[]>;
  /** Accepted-risk findings seen in the run, after the cursor, in public-id order. */
  readonly acceptedRisks: (
    runId: string,
    after: AcceptedRiskCursor | null,
    limit: number,
  ) => Promise<FindingRow[]>;
}

/** The severity rank of a finding: `-score`, so an ascending sort puts the highest score first. A missing score is `-1`. */
const SEVERITY_RANK_SQL = sql`(-COALESCE((${findings.severity}->'cvss4'->>'score')::numeric, -1))`;

function sourceFor(tx: TenantTx): ReportSource {
  return {
    async run(runId) {
      const [row] = await tx
        .select({ id: runs.id, publicId: runs.publicId, manifest: runs.manifest })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      return row;
    },

    async coverage(runId) {
      const [row] = await tx
        .select()
        .from(coverageManifests)
        .where(eq(coverageManifests.runId, runId))
        .limit(1);
      return row;
    },

    async releasedFindings(runId, after, limit) {
      const keyset = after
        ? sql`AND (${SEVERITY_RANK_SQL}, ${findings.class}, ${findings.publicId}) > (${after.severityRank}::numeric, ${after.class}, ${after.publicId})`
        : sql``;
      const rows = await tx
        .select({
          finding: findings,
          evidenceRefs: findingOccurrences.evidenceRefs,
          severityRank: sql<string>`${SEVERITY_RANK_SQL}`,
        })
        .from(findings)
        .innerJoin(
          findingOccurrences,
          and(eq(findingOccurrences.findingId, findings.id), eq(findingOccurrences.runId, runId)),
        )
        .where(sql`${findings.status} = 'released' ${keyset}`)
        .orderBy(sql`${SEVERITY_RANK_SQL} ASC`, findings.class, findings.publicId)
        .limit(limit);
      return rows.map((row) => ({
        finding: row.finding,
        evidenceRefs: row.evidenceRefs,
        severityRank: Number(row.severityRank),
      }));
    },

    async acceptedRisks(runId, after, limit) {
      const rows = await tx
        .select({ finding: findings })
        .from(findings)
        .innerJoin(
          findingOccurrences,
          and(eq(findingOccurrences.findingId, findings.id), eq(findingOccurrences.runId, runId)),
        )
        .where(
          and(
            eq(findings.status, 'accepted_risk'),
            after ? gt(findings.publicId, after.publicId) : undefined,
          ),
        )
        .orderBy(findings.publicId)
        .limit(limit);
      return rows.map((row) => row.finding);
    },
  };
}

/**
 * Runs `fn` with a report source bound to one tenant, inside one transaction. A missing tenant context fails closed
 * (`withTenant`), and RLS hides every other tenant's runs, findings and manifests, so a cross-tenant run id reads as
 * absent.
 */
export function withReportSource<T>(
  db: Database,
  tenantId: string,
  fn: (source: ReportSource) => Promise<T>,
): Promise<T> {
  return withTenant(db, tenantId, (tx) => fn(sourceFor(tx)));
}
