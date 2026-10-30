import type { DashboardFindingFilter, DashboardTrendBucket } from '@blackwing/contracts';
import type {
  AssetCoverageRow,
  CoverageManifestRow,
  DashboardPosition,
  FindingRow,
  FindingSummaryRows,
  HiddenStatuses,
  TrendRow,
} from '@blackwing/db';

/**
 * Persistence of the dashboard reads (DASH-001). Every call takes the tenant the request was resolved to, and the
 * Postgres adapter (`DashboardRepository` in @blackwing/db) runs it under that tenant's RLS context, so another tenant's
 * rows are never counted or returned. `hidden` lists the statuses the viewer may not see (the Suspected rule, F17).
 */
export interface DashboardStore {
  summary(
    tenantId: string,
    filter: DashboardFindingFilter,
    hidden: HiddenStatuses,
  ): Promise<FindingSummaryRows>;
  trend(
    tenantId: string,
    assetId: string,
    bucket: DashboardTrendBucket,
    hidden: HiddenStatuses,
  ): Promise<TrendRow[]>;
  coverageOfRun(tenantId: string, runId: string): Promise<CoverageManifestRow | undefined>;
  latestCoverageOfAsset(tenantId: string, assetId: string): Promise<AssetCoverageRow | undefined>;
  connection(
    tenantId: string,
    filter: DashboardFindingFilter,
    hidden: HiddenStatuses,
    limit: number,
    after?: DashboardPosition,
  ): Promise<FindingRow[]>;
  assetNames(tenantId: string, assetIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
