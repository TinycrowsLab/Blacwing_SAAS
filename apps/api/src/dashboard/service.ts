// Read service of the dashboards (DASH-001). It owns the authorisation of a read (RBAC `finding:read` or
// `coverage:read`, then the Suspected rule of F17), the validation of every client value, the keyset cursor, the
// banding of the counts, and the metrics and slow-query log. The aggregates are computed by the store in SQL; this
// service never sums rows itself.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import {
  cvssSeverityBandSchema,
  DASHBOARD_PAGE,
  DASHBOARD_UNCATEGORISED,
  DASHBOARD_UNSCORED,
  type DashboardFindingFilter,
  dashboardFindingFilterSchema,
  type DashboardSeverity,
  type DashboardTrendBucket,
  dashboardTrendBucketSchema,
  type Permission,
  uuidV7Schema,
} from '@blackwing/contracts';
import { dashboardSeverityOfBand, hasPermission } from '@blackwing/domain';
import { ForbiddenError, ValidationError } from '@blackwing/errors';

import { createCedarFindingPolicy, type FindingPolicyEngine } from '../findings/policy.js';
import { type CursorCodec, invalidCursor } from '../pagination/index.js';

import type { DashboardMetrics, DashboardQueryName } from './metrics.js';
import type { DashboardStore } from './ports.js';
import type { FindingMemberships } from '../findings/ports.js';
import type { CoverageManifestRow, FindingRow, HiddenStatuses, TrendRow } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const FINDINGS_PERMISSION: Permission = 'finding:read';
const COVERAGE_PERMISSION: Permission = 'coverage:read';
/** The collection-level probe of the Cedar rule: may the viewer read suspected findings at all? */
const COLLECTION_PROBE = '*';
const SUSPECTED = 'suspected';
/** A read slower than this is logged with its query name and tenant (never its filter values). */
export const DASHBOARD_SLOW_QUERY_MS = 500;
/** Baseline state of a finding no diff was computed for yet (a null `baseline_status`). */
const NOT_RETESTED = 'not_retested';
/** Direction of the connection's keyset (newest first). */
const CURSOR_DIRECTION = 'desc';
/** Length of the filter digest a cursor is bound to. */
const SIGNATURE_LENGTH = 32;

const uuidSchema = z.uuid();

/** The caller: the tenant the guard resolved for the request and the user acting in it. */
export interface DashboardPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface DashboardServiceDeps {
  readonly store: DashboardStore;
  readonly memberships: FindingMemberships;
  /** HMAC cursor codec (`API_CURSOR_SECRET`); a cursor is refused unless this service issued it for the same query. */
  readonly cursors: CursorCodec;
  /** The Cedar resource rules for suspected findings. Absent: the baseline policy set. */
  readonly policy?: FindingPolicyEngine;
  readonly metrics: DashboardMetrics;
  readonly logger: Pick<Logger, 'warn'>;
  /** Clock of the slow-query check, in milliseconds (tests pin it). */
  readonly now?: () => number;
}

/** One count of a group: its key and how many findings carry it. */
export interface DashboardCount {
  readonly key: string;
  readonly count: number;
}

/** A count of findings per asset; `assetName` is resolved by the GraphQL DataLoader, not here. */
export interface DashboardAssetCount {
  readonly assetId: string;
  readonly count: number;
}

/** The counts of one scope of findings, per dimension (every list is empty, never null, when there is nothing). */
export interface DashboardSummary {
  readonly total: number;
  readonly bySeverity: readonly DashboardCount[];
  readonly byOwaspCategory: readonly DashboardCount[];
  readonly byCweId: readonly DashboardCount[];
  readonly byAsset: readonly DashboardAssetCount[];
  readonly byStatus: readonly DashboardCount[];
  readonly byBaselineStatus: readonly DashboardCount[];
}

/** One bucket of a trend: its start (ISO UTC) and the distinct findings in each baseline state. */
export interface DashboardTrendPoint {
  readonly bucketStart: string;
  readonly total: number;
  readonly counts: readonly DashboardCount[];
}

export interface DashboardTrend {
  readonly assetId: string;
  readonly bucket: DashboardTrendBucket;
  readonly points: readonly DashboardTrendPoint[];
}

/**
 * The coverage of one run. A run with no manifest is `finalised: false` with every number and percentage null, so a
 * caller never reads a missing manifest as zero coverage.
 */
export interface DashboardCoverage {
  readonly runId: string | null;
  readonly assetId: string | null;
  readonly finalised: boolean;
  /** Share of the planned test cases the run executed, as a percentage with one decimal. */
  readonly coveragePercent: number | null;
  readonly testCasesPlanned: number | null;
  readonly testCasesExecuted: number | null;
  readonly finalisedAt: string | null;
}

/** One finding as the dashboard shows it: metadata and counts only, never target content (§8.7). */
export interface DashboardFindingView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly baselineStatus: string | null;
  readonly severity: DashboardSeverity | null;
  readonly cweId: string | null;
  readonly owaspCategory: string | null;
  readonly assetId: string;
  readonly runId: string;
  readonly firstSeenRunId: string;
  readonly lastSeenRunId: string;
  readonly createdAt: string;
}

export interface DashboardFindingPage {
  readonly items: readonly DashboardFindingView[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Parses the client filter with the contract. An unknown field or value is refused, never dropped. */
function filterOf(raw: unknown): DashboardFindingFilter {
  const parsed = dashboardFindingFilterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError('invalid dashboard filter', {
      detail: `Invalid filter: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return parsed.data;
}

/** A UUIDv7 argument, or a validation error naming the argument (never the value). */
function idOf(value: unknown, name: string): string {
  const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${name} must be a UUIDv7`);
  return parsed.data;
}

/** The page size: the default when absent, otherwise an integer from 1 to the maximum (refused above it). */
function pageSizeOf(limit: unknown): number {
  if (limit === undefined || limit === null) return DASHBOARD_PAGE.defaultSize;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(
      `limit must be an integer from 1 to ${String(DASHBOARD_PAGE.maxSize)}`,
    );
  }
  if (limit > DASHBOARD_PAGE.maxSize) {
    throw new ValidationError(`limit must be at most ${String(DASHBOARD_PAGE.maxSize)}`);
  }
  return limit;
}

/**
 * The digest a connection cursor is bound to: the filter and the statuses the viewer may see. A cursor replayed on
 * another filter, or by a viewer with other visibility, is refused as an invalid cursor.
 */
function signatureOf(filter: DashboardFindingFilter, hidden: HiddenStatuses): string {
  const entries = Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([entries, hidden]))
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

/** Encodes the keyset position of the last row of a page as an HMAC-signed cursor. */
function encodeCursor(cursors: CursorCodec, row: FindingRow, signature: string): string {
  return cursors.encode({
    k: [row.createdAt.toISOString(), row.id],
    d: CURSOR_DIRECTION,
    s: signature,
  });
}

/** Verifies and decodes a cursor. Anything not issued for this query is an invalid cursor, never a silent first page. */
function decodeCursor(
  cursors: CursorCodec,
  token: string,
  signature: string,
): { createdAt: Date; id: string } {
  const payload = cursors.decode(token, { d: CURSOR_DIRECTION, s: signature });
  const [created, id] = payload.k;
  if (typeof created !== 'string' || typeof id !== 'string') throw invalidCursor();
  const createdAt = new Date(created);
  if (Number.isNaN(createdAt.getTime()) || !uuidV7Schema.safeParse(id).success) {
    throw invalidCursor();
  }
  return { createdAt, id };
}

/** The dashboard severity of a stored severity object, or null when the finding is unscored. */
function severityOf(severity: Record<string, unknown> | null): DashboardSeverity | null {
  const band = z
    .object({ cvss4: z.object({ severity: cvssSeverityBandSchema }) })
    .safeParse(severity);
  return band.success ? dashboardSeverityOfBand(band.data.cvss4.severity) : null;
}

/** The count groups of one dimension, keyed for the console (a null key becomes its named bucket). */
function groupsOf(
  rows: readonly { key: string | null; count: number }[],
  keyOf: (key: string | null) => string,
): DashboardCount[] {
  return rows.map((row) => ({ key: keyOf(row.key), count: row.count }));
}

/** The severity bucket of a stored band: `none` is `info`, a null band is `unscored`. */
function severityKey(band: string | null): string {
  if (band === null) return DASHBOARD_UNSCORED;
  return dashboardSeverityOfBand(cvssSeverityBandSchema.parse(band));
}

/** Percentages are reported with one decimal place: a whole percent, then tenths. */
const PERCENT = 100;
const TENTHS = 10;

/** Coverage percentage with one decimal; null when the manifest has no test case to cover. */
function percentOf(executed: number, planned: number): number | null {
  if (planned <= 0) return null;
  return Math.round((executed / planned) * PERCENT * TENTHS) / TENTHS;
}

/**
 * The coverage of one run from its manifest: the planned test cases are the entries, the executed ones the entries
 * with status `tested`. A missing manifest is `finalised: false` with no number at all.
 */
function coverageOf(
  row: CoverageManifestRow | null | undefined,
  runId: string | null,
  assetId: string | null,
): DashboardCoverage {
  if (row === null || row === undefined) {
    return {
      runId,
      assetId,
      finalised: false,
      coveragePercent: null,
      testCasesPlanned: null,
      testCasesExecuted: null,
      finalisedAt: null,
    };
  }
  const planned = row.entries.length;
  const executed = row.entries.filter((entry) => entry.status === 'tested').length;
  return {
    runId: row.runId,
    assetId,
    finalised: row.finalisedAt !== null,
    coveragePercent: percentOf(executed, planned),
    testCasesPlanned: planned,
    testCasesExecuted: executed,
    finalisedAt: row.finalisedAt === null ? null : row.finalisedAt.toISOString(),
  };
}

/** The dashboard read service (DASH-001). Construct once per process; every method takes the caller's principal. */
export class DashboardService {
  private readonly policy: FindingPolicyEngine;
  private readonly now: () => number;

  constructor(private readonly deps: DashboardServiceDeps) {
    this.policy = deps.policy ?? createCedarFindingPolicy();
    this.now = deps.now ?? (() => performance.now());
  }

  /** Counts of the findings matching `rawFilter`, per dimension. Requires `finding:read`. */
  async summary(principal: DashboardPrincipal, rawFilter: unknown): Promise<DashboardSummary> {
    const hidden = await this.readable(principal, FINDINGS_PERMISSION);
    const filter = filterOf(rawFilter);
    return this.measure('summary', principal, async () => {
      const rows = await this.deps.store.summary(principal.tenantId, filter, hidden.statuses);
      const summary: DashboardSummary = {
        total: rows.total,
        bySeverity: groupsOf(rows.severity, (key) => severityKey(key)),
        byOwaspCategory: groupsOf(rows.owaspCategory, (key) => key ?? DASHBOARD_UNCATEGORISED),
        byCweId: groupsOf(rows.cweId, (key) => key ?? DASHBOARD_UNCATEGORISED),
        byAsset: rows.assetId.flatMap((row) =>
          row.key === null ? [] : [{ assetId: row.key, count: row.count }],
        ),
        byStatus: groupsOf(rows.status, (key) => key ?? ''),
        byBaselineStatus: groupsOf(rows.baselineStatus, (key) => key ?? NOT_RETESTED),
      };
      return { value: summary, rows: rows.total };
    });
  }

  /** Distinct findings of one asset per UTC day or ISO week, per baseline state. Requires `finding:read`. */
  async trend(
    principal: DashboardPrincipal,
    rawAssetId: unknown,
    rawBucket: unknown,
  ): Promise<DashboardTrend> {
    const hidden = await this.readable(principal, FINDINGS_PERMISSION);
    const assetId = idOf(rawAssetId, 'assetId');
    const bucket = dashboardTrendBucketSchema.safeParse(rawBucket);
    if (!bucket.success) throw new ValidationError('bucket must be day or week');
    return this.measure('trend', principal, async () => {
      const rows = await this.deps.store.trend(
        principal.tenantId,
        assetId,
        bucket.data,
        hidden.statuses,
      );
      const points = pointsOf(rows);
      return {
        value: { assetId, bucket: bucket.data, points },
        rows: points.length,
      };
    });
  }

  /**
   * The coverage of one run, or of the newest run of one asset: exactly one of the two is required. Requires
   * `coverage:read`. A run with no manifest answers `finalised: false` and no percentage.
   */
  async coverage(
    principal: DashboardPrincipal,
    ref: { readonly runId?: unknown; readonly assetId?: unknown },
  ): Promise<DashboardCoverage> {
    await this.requireRole(principal, COVERAGE_PERMISSION);
    const hasRun = ref.runId !== undefined && ref.runId !== null;
    const hasAsset = ref.assetId !== undefined && ref.assetId !== null;
    if (hasRun === hasAsset) {
      throw new ValidationError('coverageSummary needs exactly one of runId or assetId');
    }
    return this.measure('coverage', principal, async () => {
      if (hasRun) {
        const runId = idOf(ref.runId, 'runId');
        const row = await this.deps.store.coverageOfRun(principal.tenantId, runId);
        return { value: coverageOf(row, runId, null), rows: row === undefined ? 0 : 1 };
      }
      const assetId = idOf(ref.assetId, 'assetId');
      const latest = await this.deps.store.latestCoverageOfAsset(principal.tenantId, assetId);
      return {
        value: coverageOf(latest?.coverage, latest?.runId ?? null, assetId),
        rows: latest === undefined ? 0 : 1,
      };
    });
  }

  /**
   * One keyset page of the findings matching `rawFilter`, newest first. `limit` is an integer up to 200 (default 50).
   * Requires `finding:read`. A cursor that is not from this query is refused.
   */
  async connection(
    principal: DashboardPrincipal,
    input: {
      readonly filter?: unknown;
      readonly cursor?: string | undefined;
      readonly limit?: unknown;
    },
  ): Promise<DashboardFindingPage> {
    const hidden = await this.readable(principal, FINDINGS_PERMISSION);
    const filter = filterOf(input.filter);
    const size = pageSizeOf(input.limit);
    const signature = signatureOf(filter, hidden.statuses);
    const after =
      input.cursor === undefined
        ? undefined
        : decodeCursor(this.deps.cursors, input.cursor, signature);
    return this.measure('connection', principal, async () => {
      const rows = await this.deps.store.connection(
        principal.tenantId,
        filter,
        hidden.statuses,
        size + 1,
        after,
      );
      const hasMore = rows.length > size;
      const page = hasMore ? rows.slice(0, size) : rows;
      const last = page.at(-1);
      return {
        value: {
          items: page.map((row) => viewOf(row)),
          nextCursor:
            hasMore && last !== undefined ? encodeCursor(this.deps.cursors, last, signature) : null,
          hasMore,
        },
        rows: page.length,
      };
    });
  }

  /**
   * Display names of assets, for the DataLoader of the summary's asset groups. Not authorised here: it is only reached
   * from a summary the caller has already been authorised for, and it runs under the tenant it is given.
   */
  async assetNamesOf(
    tenantId: string,
    assetIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.deps.store.assetNames(tenantId, assetIds);
  }

  /** The statuses hidden from the caller: the suspected ones, unless the Cedar rule lets the viewer read them. */
  private async readable(
    principal: DashboardPrincipal,
    permission: Permission,
  ): Promise<{ readonly statuses: HiddenStatuses }> {
    const roles = await this.requireRole(principal, permission);
    const seesSuspected = this.policy.allows(
      { userId: principal.actorId, tenantId: principal.tenantId, roles },
      { id: COLLECTION_PROBE, tenantId: principal.tenantId, status: 'suspected' },
    );
    return { statuses: seesSuspected ? [] : [SUSPECTED] };
  }

  /** The caller's roles in the tenant, after RBAC. A caller without the permission is refused (fail closed). */
  private async requireRole(
    principal: DashboardPrincipal,
    permission: Permission,
  ): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    const roles = userId.success
      ? await this.deps.memberships.rolesOf(principal.tenantId, userId.data)
      : [];
    if (!hasPermission(roles, permission)) {
      throw new ForbiddenError('the caller may not read this dashboard', {
        detail: `Missing permission ${permission} in this tenant.`,
      });
    }
    return roles;
  }

  /** Times one read, records its metrics, and logs it when it is slow (query name and tenant only). */
  private async measure<T>(
    query: DashboardQueryName,
    principal: DashboardPrincipal,
    read: () => Promise<{ value: T; rows: number }>,
  ): Promise<T> {
    const started = this.now();
    const { value, rows } = await read();
    const durationMs = this.now() - started;
    this.deps.metrics.observe(query, durationMs, rows);
    if (durationMs > DASHBOARD_SLOW_QUERY_MS) {
      this.deps.logger.warn(
        { query, tenantId: principal.tenantId, durationMs: Math.round(durationMs) },
        'graphql.dashboard_slow_query',
      );
    }
    return value;
  }
}

/** One finding row as the dashboard view. */
function viewOf(row: FindingRow): DashboardFindingView {
  return {
    id: row.publicId,
    title: row.title,
    status: row.status,
    baselineStatus: row.baselineStatus,
    severity: severityOf(row.severity),
    cweId: row.cweId,
    owaspCategory: row.owaspCategory,
    assetId: row.assetId,
    runId: row.runId,
    firstSeenRunId: row.firstSeenRunId,
    lastSeenRunId: row.lastSeenRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Trend rows as points: one per bucket, ascending, each with its baseline states. */
function pointsOf(rows: readonly TrendRow[]): DashboardTrendPoint[] {
  const byBucket = new Map<string, { total: number; counts: Map<string, number> }>();
  for (const row of rows) {
    const bucketStart = row.bucketStart.toISOString();
    const point = byBucket.get(bucketStart) ?? { total: 0, counts: new Map<string, number>() };
    const state = row.baselineStatus ?? NOT_RETESTED;
    point.counts.set(state, (point.counts.get(state) ?? 0) + row.count);
    point.total += row.count;
    byBucket.set(bucketStart, point);
  }
  return [...byBucket]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucketStart, point]) => ({
      bucketStart,
      total: point.total,
      counts: [...point.counts].map(([key, count]) => ({ key, count })),
    }));
}
