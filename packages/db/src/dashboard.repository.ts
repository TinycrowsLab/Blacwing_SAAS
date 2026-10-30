// Read model of the GraphQL dashboards (DASH-001, CONTEXT_PACK §7, §8.6). Every method takes the tenant the caller was
// resolved to and runs in `withTenant`, so RLS confines it and a missing tenant fails closed. The aggregates are
// computed here in SQL, never in the browser. Each read runs at repeatable read, so the groups of one summary come from
// one snapshot and a run that writes occurrences meanwhile cannot make the counts disagree.
//
// Baseline states are read from `findings.baseline_status`, which BASELINE precomputes. This module never diffs baselines.

import { and, asc, desc, eq, inArray, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';

import {
  type BaselineStatus,
  type DashboardFindingFilter,
  type DashboardTrendBucket,
  type FindingStatus,
  RELEASED_FINDING_STATUSES,
} from '@blackwing/contracts';
import { storedBandOfSeverity } from '@blackwing/domain';

import { assets } from './schema/assets.js';
import { coverageManifests, type CoverageManifestRow } from './schema/coverage-manifests.js';
import { findingOccurrences, findings } from './schema/findings.js';
import { runs } from './schema/runs.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { FindingRow } from './finding.repository.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** One group of a summary: its key (null when the grouped column is null) and how many findings carry it. */
export interface CountRow {
  readonly key: string | null;
  readonly count: number;
}

/** The counts of one summary, every group read from the same snapshot. */
export interface FindingSummaryRows {
  readonly total: number;
  /** Key: the stored CVSS v4.0 band (`none` for a score of 0); null when the finding is unscored. */
  readonly severity: readonly CountRow[];
  readonly owaspCategory: readonly CountRow[];
  readonly cweId: readonly CountRow[];
  readonly assetId: readonly CountRow[];
  readonly status: readonly CountRow[];
  /** Key: the baseline state; null (no diff computed yet) is for the caller to name. */
  readonly baselineStatus: readonly CountRow[];
}

/** One time bucket of a trend for one baseline state. `count` is the number of distinct findings. */
export interface TrendRow {
  readonly bucketStart: Date;
  readonly baselineStatus: string | null;
  readonly count: number;
}

/**
 * The newest run of one asset and its coverage. `coverage` is null while the run has no manifest yet (still
 * recording), which the caller reads as not finalised, never as zero coverage.
 */
export interface AssetCoverageRow {
  readonly runId: string;
  readonly coverage: CoverageManifestRow | null;
}

/** Keyset position of a connection page: the last row of the previous page (`createdAt` desc, then `id` desc). */
export interface DashboardPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** Statuses the viewer may not see (the Suspected rule, F17). They are excluded from every aggregate and row. */
export type HiddenStatuses = readonly FindingStatus[];

export interface DashboardRepositoryOptions {
  readonly db: Database;
}

/** The stored CVSS v4.0 band of a finding (`severity.cvss4.severity`). */
const SEVERITY_BAND = sql`${findings.severity} -> 'cvss4' ->> 'severity'`;

/**
 * The WHERE conditions of one filter, with the hidden statuses. Every condition is ANDed; the values of one list
 * field are ORed. The tenant predicate is always first. `info` matches the stored `none` band.
 */
function conditionsOf(
  tenantId: string,
  filter: DashboardFindingFilter,
  hidden: HiddenStatuses,
): SQL[] {
  const conditions: SQL[] = [eq(findings.tenantId, tenantId)];
  if (hidden.length > 0) conditions.push(notInArray(findings.status, [...hidden]));
  if (filter.assetIds !== undefined) {
    conditions.push(inArray(findings.assetId, [...filter.assetIds]));
  }
  if (filter.severities !== undefined) {
    const bands = filter.severities.map((severity) => storedBandOfSeverity(severity));
    conditions.push(inArray(SEVERITY_BAND, bands));
  }
  if (filter.owaspCategories !== undefined) {
    conditions.push(inArray(findings.owaspCategory, [...filter.owaspCategories]));
  }
  if (filter.cweIds !== undefined) conditions.push(inArray(findings.cweId, [...filter.cweIds]));
  if (filter.statuses !== undefined) {
    conditions.push(inArray(findings.status, [...filter.statuses]));
  }
  if (filter.baselineStatuses !== undefined) {
    conditions.push(baselineCondition(filter.baselineStatuses) ?? sql`false`);
  }
  if (filter.runIds !== undefined) {
    // A finding matches a run when an occurrence of it exists in that run.
    const seen = sql`(select ${findingOccurrences.findingId} from ${findingOccurrences} where ${and(
      eq(findingOccurrences.tenantId, tenantId),
      inArray(findingOccurrences.runId, [...filter.runIds]),
    )})`;
    conditions.push(inArray(findings.id, seen));
  }
  if (filter.releasedOnly === true) {
    conditions.push(inArray(findings.status, [...RELEASED_FINDING_STATUSES]));
  }
  return conditions;
}

/** A baseline list as one condition: a null baseline matches `not_retested`. Undefined for an empty list. */
function baselineCondition(states: readonly BaselineStatus[]): SQL | undefined {
  const named = states.filter((state) => state !== 'not_retested');
  return or(
    ...(named.length > 0 ? [inArray(findings.baselineStatus, named)] : []),
    ...(states.includes('not_retested') ? [isNull(findings.baselineStatus)] : []),
  );
}

/** One `GROUP BY` of the summary over `column`, counting the filtered findings. Largest group first. */
async function countBy(
  tx: TenantTx,
  conditions: SQL[],
  column: AnyPgColumn | SQL,
): Promise<CountRow[]> {
  const key = sql<string | null>`${column}`;
  const rows = await tx
    .select({ key, count: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(...conditions))
    .groupBy(key)
    .orderBy(desc(sql`count(*)`), asc(key));
  return rows.map((row) => ({ key: row.key, count: row.count }));
}

/**
 * The read model of the dashboards. Each method takes the caller's tenant (resolved server side) and runs in one
 * tenant transaction, so RLS and the explicit tenant predicate both confine it.
 */
export class DashboardRepository {
  constructor(private readonly options: DashboardRepositoryOptions) {}

  /** Counts of the findings matching `filter`, grouped per dimension, all from one snapshot. */
  async summary(
    tenantId: string,
    filter: DashboardFindingFilter,
    hidden: HiddenStatuses,
  ): Promise<FindingSummaryRows> {
    return withTenant(
      this.options.db,
      tenantId,
      async (tx) => {
        const conditions = conditionsOf(tenantId, filter, hidden);
        const [totalRow] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(findings)
          .where(and(...conditions));
        return {
          total: totalRow?.total ?? 0,
          severity: await countBy(tx, conditions, SEVERITY_BAND),
          owaspCategory: await countBy(tx, conditions, findings.owaspCategory),
          cweId: await countBy(tx, conditions, findings.cweId),
          assetId: await countBy(tx, conditions, findings.assetId),
          status: await countBy(tx, conditions, findings.status),
          baselineStatus: await countBy(tx, conditions, findings.baselineStatus),
        };
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Distinct findings of one asset per time bucket (UTC day or ISO week of their occurrence) and baseline state. Only
   * the findings the viewer may see are counted.
   */
  async trend(
    tenantId: string,
    assetId: string,
    bucket: DashboardTrendBucket,
    hidden: HiddenStatuses,
  ): Promise<TrendRow[]> {
    return withTenant(
      this.options.db,
      tenantId,
      async (tx) => {
        // Truncated on the UTC wall clock and formatted here, so the bucket never depends on the session time zone.
        const bucketStart = sql<string>`to_char(date_trunc(${bucket}::text, ${findingOccurrences.detectedAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
        const rows = await tx
          .select({
            bucketStart,
            baselineStatus: findings.baselineStatus,
            count: sql<number>`count(distinct ${findings.id})::int`,
          })
          .from(findingOccurrences)
          .innerJoin(
            findings,
            and(
              eq(findings.tenantId, findingOccurrences.tenantId),
              eq(findings.id, findingOccurrences.findingId),
            ),
          )
          .where(
            and(
              eq(findingOccurrences.tenantId, tenantId),
              eq(findings.assetId, assetId),
              ...(hidden.length > 0 ? [notInArray(findings.status, [...hidden])] : []),
            ),
          )
          .groupBy(sql`1, 2`)
          .orderBy(sql`1`, sql`2`);
        return rows.map((row) => ({
          bucketStart: new Date(row.bucketStart),
          baselineStatus: row.baselineStatus,
          count: row.count,
        }));
      },
      { isolation: 'repeatable read' },
    );
  }

  /** The coverage manifest of one run, or undefined when the run has none. */
  async coverageOfRun(tenantId: string, runId: string): Promise<CoverageManifestRow | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(coverageManifests)
        .where(and(eq(coverageManifests.tenantId, tenantId), eq(coverageManifests.runId, runId)))
        .limit(1);
      return row;
    });
  }

  /**
   * The newest run of an asset (its `assetSummaries` in the run manifest) with its coverage manifest, or undefined when
   * the asset has no run in the tenant.
   */
  async latestCoverageOfAsset(
    tenantId: string,
    assetId: string,
  ): Promise<AssetCoverageRow | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({ runId: runs.id, coverage: coverageManifests })
        .from(runs)
        .leftJoin(
          coverageManifests,
          and(eq(coverageManifests.tenantId, runs.tenantId), eq(coverageManifests.runId, runs.id)),
        )
        .where(
          and(
            eq(runs.tenantId, tenantId),
            sql`${runs.manifest} -> 'assetSummaries' @> jsonb_build_array(jsonb_build_object('assetId', ${assetId}::text))`,
          ),
        )
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(1);
      return row;
    });
  }

  /**
   * One keyset page of the findings matching `filter`, newest first (`created_at` desc, then `id` desc). The keyset uses
   * the millisecond instant the index orders by, so pages concatenate to the unpaged result. The caller passes
   * `limit` one above the page size to learn whether a next page exists.
   */
  async connection(
    tenantId: string,
    filter: DashboardFindingFilter,
    hidden: HiddenStatuses,
    limit: number,
    after?: DashboardPosition,
  ): Promise<FindingRow[]> {
    const createdAt = sql`date_trunc('milliseconds', ${findings.createdAt})`;
    return withTenant(
      this.options.db,
      tenantId,
      (tx) => {
        const conditions = conditionsOf(tenantId, filter, hidden);
        if (after !== undefined) {
          conditions.push(
            sql`(${createdAt}, ${findings.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
          );
        }
        return tx
          .select()
          .from(findings)
          .where(and(...conditions))
          .orderBy(desc(createdAt), desc(findings.id))
          .limit(limit);
      },
      { isolation: 'repeatable read' },
    );
  }

  /** Display names of the live assets among `assetIds`. A missing, deleted or foreign id is absent. */
  async assetNames(
    tenantId: string,
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: assets.id, name: assets.name })
        .from(assets)
        .where(
          and(
            eq(assets.tenantId, tenantId),
            inArray(assets.id, [...assetIds]),
            isNull(assets.deletedAt),
          ),
        );
      return new Map(rows.map((row) => [row.id, row.name]));
    });
  }
}
