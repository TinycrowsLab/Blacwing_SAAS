import { Field, Float, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { DASHBOARD_UNCATEGORISED, DASHBOARD_UNSCORED } from '@blackwing/contracts';

/** The trend bucket of `findingTrend`: UTC days or ISO weeks. */
export enum DashboardTrendBucket {
  day = 'day',
  week = 'week',
}
registerEnumType(DashboardTrendBucket, {
  name: 'DashboardTrendBucket',
  description: 'Time bucket of a finding trend: UTC day or ISO week (Monday start).',
});

/** Filters of the dashboard reads (DASH-001). Fields combine with AND, the values of one field with OR. */
@InputType('DashboardFindingFilter', {
  description: 'Filters of the dashboard reads (combined with AND; values of one field with OR).',
})
export class DashboardFindingFilterModel {
  @Field(() => [ID], { nullable: true, description: 'Assets (UUIDv7).' })
  readonly assetIds?: string[];

  @Field(() => [String], {
    nullable: true,
    description: 'Severity buckets: critical, high, medium, low or info.',
  })
  readonly severities?: string[];

  @Field(() => [String], { nullable: true, description: 'OWASP Top 10 categories, A01 to A10.' })
  readonly owaspCategories?: string[];

  @Field(() => [String], { nullable: true, description: 'CWE ids, such as CWE-89.' })
  readonly cweIds?: string[];

  @Field(() => [String], { nullable: true, description: 'Lifecycle statuses.' })
  readonly statuses?: string[];

  @Field(() => [String], {
    nullable: true,
    description: 'Baseline states: new, open, fixed, returned or not_retested.',
  })
  readonly baselineStatuses?: string[];

  @Field(() => [ID], {
    nullable: true,
    description: 'Runs (UUIDv7): findings seen in any of them.',
  })
  readonly runIds?: string[];

  @Field(() => Boolean, { nullable: true, description: 'Only findings a human released.' })
  readonly releasedOnly?: boolean;
}

/** One count of a dimension: its key and the number of findings. */
@ObjectType('DashboardCount', { description: 'A count of findings for one key.' })
export class DashboardCountModel {
  @Field(() => String, {
    description: `The key. A missing value is named: ${DASHBOARD_UNCATEGORISED} (CWE or OWASP) or ${DASHBOARD_UNSCORED} (severity).`,
  })
  readonly key!: string;

  @Field(() => Int)
  readonly count!: number;
}

/** A count of findings for one asset. `assetName` is batched through a DataLoader. */
@ObjectType('DashboardAssetCount', { description: 'A count of findings for one asset.' })
export class DashboardAssetCountModel {
  @Field(() => ID)
  readonly assetId!: string;

  @Field(() => Int)
  readonly count!: number;
}

/** Counts of the findings matching the filter, per dimension. */
@ObjectType('FindingSummary', { description: 'Counts of findings grouped per dimension.' })
export class FindingSummaryModel {
  @Field(() => Int, { description: 'Findings matching the filter.' })
  readonly total!: number;

  @Field(() => [DashboardCountModel], { description: 'By CVSS v4.0 band (unscored when none).' })
  readonly bySeverity!: DashboardCountModel[];

  @Field(() => [DashboardCountModel], { description: 'By OWASP Top 10 category.' })
  readonly byOwaspCategory!: DashboardCountModel[];

  @Field(() => [DashboardCountModel], { description: 'By CWE id.' })
  readonly byCweId!: DashboardCountModel[];

  @Field(() => [DashboardAssetCountModel], { description: 'By asset.' })
  readonly byAsset!: DashboardAssetCountModel[];

  @Field(() => [DashboardCountModel], { description: 'By lifecycle status.' })
  readonly byStatus!: DashboardCountModel[];

  @Field(() => [DashboardCountModel], { description: 'By baseline state.' })
  readonly byBaselineStatus!: DashboardCountModel[];
}

/** One bucket of a trend: the distinct findings in each baseline state. */
@ObjectType('FindingTrendPoint', { description: 'Findings of one asset in one time bucket.' })
export class FindingTrendPointModel {
  @Field(() => String, { description: 'Start of the bucket, ISO-8601 UTC.' })
  readonly bucketStart!: string;

  @Field(() => Int)
  readonly total!: number;

  @Field(() => [DashboardCountModel], { description: 'Distinct findings per baseline state.' })
  readonly counts!: DashboardCountModel[];
}

/** The trend of one asset. */
@ObjectType('FindingTrend', { description: 'Findings of one asset over time, per baseline state.' })
export class FindingTrendModel {
  @Field(() => ID)
  readonly assetId!: string;

  @Field(() => DashboardTrendBucket)
  readonly bucket!: DashboardTrendBucket;

  @Field(() => [FindingTrendPointModel], { description: 'Ascending by bucket start.' })
  readonly points!: FindingTrendPointModel[];
}

/**
 * The coverage of a run. A run with no manifest is `finalised: false` and every number is null, so a missing manifest is
 * never read as zero coverage.
 */
@ObjectType('CoverageSummary', {
  description: 'Coverage of one run, or of the newest run of an asset.',
})
export class CoverageSummaryModel {
  @Field(() => ID, { nullable: true })
  readonly runId!: string | null;

  @Field(() => ID, { nullable: true })
  readonly assetId!: string | null;

  @Field(() => Boolean, {
    description: 'True once the run is final; the manifest is then immutable.',
  })
  readonly finalised!: boolean;

  @Field(() => Float, {
    nullable: true,
    description: 'Executed test cases as a percentage of the planned ones, one decimal.',
  })
  readonly coveragePercent!: number | null;

  @Field(() => Int, { nullable: true })
  readonly testCasesPlanned!: number | null;

  @Field(() => Int, { nullable: true })
  readonly testCasesExecuted!: number | null;

  @Field(() => String, { nullable: true, description: 'ISO-8601 UTC, when finalised.' })
  readonly finalisedAt!: string | null;
}

/** One finding of a dashboard page: its metadata and counts, never target content (§8.7). */
@ObjectType('DashboardFinding', { description: 'A finding of a dashboard page (metadata only).' })
export class DashboardFindingModel {
  @Field(() => ID)
  readonly id!: string;

  @Field(() => String)
  readonly title!: string;

  @Field(() => String)
  readonly status!: string;

  @Field(() => String, { nullable: true })
  readonly baselineStatus!: string | null;

  @Field(() => String, { nullable: true, description: 'CVSS v4.0 band; null when unscored.' })
  readonly severity!: string | null;

  @Field(() => String, { nullable: true })
  readonly cweId!: string | null;

  @Field(() => String, { nullable: true })
  readonly owaspCategory!: string | null;

  @Field(() => ID)
  readonly assetId!: string;

  @Field(() => ID)
  readonly runId!: string;

  @Field(() => ID)
  readonly firstSeenRunId!: string;

  @Field(() => ID)
  readonly lastSeenRunId!: string;

  @Field(() => String, { description: 'ISO-8601 UTC.' })
  readonly createdAt!: string;
}

/** One keyset page of dashboard findings. */
@ObjectType('DashboardFindingConnection', { description: 'A page of dashboard findings.' })
export class DashboardFindingConnectionModel {
  @Field(() => [DashboardFindingModel])
  readonly items!: DashboardFindingModel[];

  @Field(() => String, { nullable: true, description: 'Pass as `cursor` for the next page.' })
  readonly nextCursor!: string | null;

  @Field(() => Boolean)
  readonly hasMore!: boolean;
}
