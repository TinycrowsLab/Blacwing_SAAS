import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError, ValidationError } from '@blackwing/errors';

import { DASHBOARD_SLOW_QUERY_MS, DashboardService } from './service.js';
import { ApiProblemError } from '../errors/problem-errors.js';
import {
  APPSEC_A,
  DEV_A,
  NOROLE_A,
  TENANT_A,
  TENANT_B,
  APPSEC_B,
  findingRow,
  memoryMemberships,
  uuidOf,
} from '../findings/fixtures.test-helpers.js';
import { createCursorCodec } from '../pagination/index.js';

import type { DashboardMetrics } from './metrics.js';
import type { DashboardStore } from './ports.js';
import type { DashboardFindingFilter } from '@blackwing/contracts';
import type { CoverageManifestRow, FindingRow, FindingSummaryRows, TrendRow } from '@blackwing/db';

const ASSET = uuidOf(0xe1);
const CURSOR_SECRET = 'd'.repeat(40);
const RUN = uuidOf(0xc1);
const NO_HIDDEN: readonly string[] = [];
const SUSPECTED_HIDDEN: readonly string[] = ['suspected'];

/** A store that answers from fixed rows and records what the service asked for. */
function fakeStore(overrides: Partial<DashboardStore> = {}, connectionRows: FindingRow[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, value: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(value);
    };
  const emptySummary: FindingSummaryRows = {
    total: 0,
    severity: [],
    owaspCategory: [],
    cweId: [],
    assetId: [],
    status: [],
    baselineStatus: [],
  };
  const store: DashboardStore = {
    summary: record('summary', emptySummary),
    trend: record<TrendRow[]>('trend', []),
    coverageOfRun: record<CoverageManifestRow | undefined>('coverageOfRun', undefined),
    latestCoverageOfAsset: record<CoverageManifestRow | undefined>(
      'latestCoverageOfAsset',
      undefined,
    ) as DashboardStore['latestCoverageOfAsset'],
    connection: record<FindingRow[]>('connection', connectionRows),
    assetNames: record('assetNames', new Map<string, string>()),
    ...overrides,
  };
  return { store, calls };
}

const metrics = (): DashboardMetrics & { observe: ReturnType<typeof vi.fn> } => ({
  observe: vi.fn(),
});

const memberships = memoryMemberships({
  [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [DEV_A]: ['developer'], [NOROLE_A]: [] },
  [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
});
const analyst = { tenantId: TENANT_A, actorId: APPSEC_A };
const developer = { tenantId: TENANT_A, actorId: DEV_A };

function serviceOf(store: DashboardStore, options: { now?: () => number } = {}) {
  const logger = { warn: vi.fn() };
  const observed = metrics();
  const service = new DashboardService({
    store,
    memberships,
    metrics: observed,
    logger,
    cursors: createCursorCodec(CURSOR_SECRET),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, logger, observed };
}

function summaryRows(overrides: Partial<FindingSummaryRows> = {}): FindingSummaryRows {
  return {
    total: 6,
    severity: [
      { key: 'critical', count: 1 },
      { key: 'none', count: 2 },
      { key: null, count: 3 },
    ],
    owaspCategory: [
      { key: 'A03', count: 5 },
      { key: null, count: 1 },
    ],
    cweId: [{ key: 'CWE-89', count: 5 }],
    assetId: [
      { key: ASSET, count: 4 },
      { key: null, count: 0 },
    ],
    status: [{ key: 'confirmed', count: 6 }],
    baselineStatus: [
      { key: 'new', count: 4 },
      { key: null, count: 2 },
    ],
    ...overrides,
  };
}

describe('summary', () => {
  it('bands the stored severity into the dashboard buckets and names the missing values', async () => {
    const { store } = fakeStore({ summary: () => Promise.resolve(summaryRows()) });
    const { service } = serviceOf(store);
    const result = await service.summary(analyst, {});
    expect(result.total).toBe(6);
    expect(result.bySeverity).toEqual([
      { key: 'critical', count: 1 },
      { key: 'info', count: 2 },
      { key: 'unscored', count: 3 },
    ]);
    expect(result.byOwaspCategory).toEqual([
      { key: 'A03', count: 5 },
      { key: 'uncategorised', count: 1 },
    ]);
    expect(result.byBaselineStatus).toEqual([
      { key: 'new', count: 4 },
      { key: 'not_retested', count: 2 },
    ]);
    expect(result.byAsset).toEqual([{ assetId: ASSET, count: 4 }]);
  });

  it('answers empty lists, never null, when nothing matches', async () => {
    const { store } = fakeStore();
    const { service } = serviceOf(store);
    expect(await service.summary(analyst, {})).toEqual({
      total: 0,
      bySeverity: [],
      byOwaspCategory: [],
      byCweId: [],
      byAsset: [],
      byStatus: [],
      byBaselineStatus: [],
    });
  });

  it('reads only the caller tenant and hides suspected findings from a developer', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await service.summary(developer, {});
    expect(calls[0]).toMatchObject({ method: 'summary', args: [TENANT_A, {}, SUSPECTED_HIDDEN] });
  });

  it('does not hide suspected findings from an analyst, who may read them', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await service.summary(analyst, {});
    expect(calls[0]?.args[2]).toEqual(NO_HIDDEN);
  });

  it('refuses a caller with no role in the tenant, and a caller of another tenant (fail closed)', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await expect(
      service.summary({ tenantId: TENANT_A, actorId: NOROLE_A }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.summary({ tenantId: TENANT_A, actorId: APPSEC_B }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.summary({ tenantId: TENANT_A, actorId: 'not-a-uuid' }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an unknown field', { severty: 'high' }],
    ['an unknown severity bucket', { severities: ['severe'] }],
    ['a malformed CWE id', { cweIds: ['CWE-0'] }],
    ['an OWASP id out of range', { owaspCategories: ['A11'] }],
    ['a non-UUID asset id', { assetIds: ['asset-1'] }],
    ['a UUIDv4 asset id (ids are UUIDv7)', { assetIds: ['6f1c2d3e-4a5b-4c6d-8e7f-901234567890'] }],
  ])('refuses %s with a validation error and runs no query', async (_label, filter) => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await expect(service.summary(analyst, filter)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('passes the filter the contract accepted, with the lists intact', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    const filter: DashboardFindingFilter = {
      assetIds: [ASSET],
      severities: ['critical', 'info'],
      releasedOnly: true,
    };
    await service.summary(analyst, filter);
    expect(calls[0]?.args[1]).toEqual(filter);
  });

  it('records the query metrics with the total as its row count', async () => {
    const { store } = fakeStore({ summary: () => Promise.resolve(summaryRows()) });
    const { service, observed } = serviceOf(store);
    await service.summary(analyst, {});
    expect(observed.observe).toHaveBeenCalledWith('summary', expect.any(Number), 6);
  });
});

describe('connection', () => {
  function rowsOf(count: number): FindingRow[] {
    return Array.from({ length: count }, (_, index) => findingRow(index + 1));
  }

  it('returns a page with the cursor of the next one when more rows exist', async () => {
    const { store, calls } = fakeStore({}, rowsOf(3));
    const { service } = serviceOf(store);
    const page = await service.connection(analyst, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    // The store is asked for one row more than the page, to learn whether a next page exists.
    expect(calls[0]?.args[3]).toBe(3);
  });

  it('ends the page without a cursor when the rows fit', async () => {
    const { store } = fakeStore({ connection: () => Promise.resolve(rowsOf(2)) });
    const { service } = serviceOf(store);
    const page = await service.connection(analyst, { limit: 2 });
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('sends the keyset of a cursor back to the store, and refuses a cursor that is not ours', async () => {
    const rows = rowsOf(3);
    const { store, calls } = fakeStore({}, rows);
    const { service } = serviceOf(store);
    const first = await service.connection(analyst, { limit: 2 });
    const cursor = first.nextCursor ?? '';
    expect(cursor).not.toBe('');
    await service.connection(analyst, { cursor, limit: 2 });
    const last = rows[1];
    expect(calls[1]?.args[4]).toEqual({ createdAt: last?.createdAt, id: last?.id });
    await expect(service.connection(analyst, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      problemCode: 'invalid_cursor',
    });
    await expect(
      service.connection(analyst, { cursor: `${cursor.slice(0, -2)}xx` }),
    ).rejects.toBeInstanceOf(ApiProblemError);
    await expect(
      service.connection(analyst, { cursor, filter: { owaspCategories: ['A01'] } }),
    ).rejects.toMatchObject({ problemCode: 'invalid_cursor' });
    await expect(service.connection(developer, { cursor })).rejects.toMatchObject({
      problemCode: 'invalid_cursor',
    });
  });

  it.each([0, -1, 1.5, 201, '50', Number.NaN])('refuses a page size of %s', async (limit) => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await expect(service.connection(analyst, { limit })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('accepts the maximum page of 200 and defaults to 50', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await service.connection(analyst, { limit: 200 });
    expect(calls[0]?.args[3]).toBe(201);
    await service.connection(analyst, {});
    expect(calls[1]?.args[3]).toBe(51);
  });

  it('exposes metadata only, never a target location', async () => {
    const row = findingRow(1, { severity: { cvss4: { severity: 'high', score: 7.5 } } });
    const { store } = fakeStore({ connection: () => Promise.resolve([row]) });
    const { service } = serviceOf(store);
    const page = await service.connection(analyst, {});
    const [item] = page.items;
    expect(item).toMatchObject({
      id: row.publicId,
      severity: 'high',
      cweId: 'CWE-285',
      status: 'confirmed',
    });
    expect(JSON.stringify(item)).not.toContain('urlTemplate');
  });
});

describe('trend', () => {
  it('groups the buckets ascending, sums each bucket and names a missing baseline not_retested', async () => {
    const rows: TrendRow[] = [
      { bucketStart: new Date('2026-10-06T00:00:00.000Z'), baselineStatus: 'new', count: 2 },
      { bucketStart: new Date('2026-10-05T00:00:00.000Z'), baselineStatus: null, count: 1 },
      { bucketStart: new Date('2026-10-06T00:00:00.000Z'), baselineStatus: 'fixed', count: 1 },
    ];
    const { store } = fakeStore({ trend: () => Promise.resolve(rows) });
    const { service } = serviceOf(store);
    const trend = await service.trend(analyst, ASSET, 'day');
    expect(trend.points).toEqual([
      {
        bucketStart: '2026-10-05T00:00:00.000Z',
        total: 1,
        counts: [{ key: 'not_retested', count: 1 }],
      },
      {
        bucketStart: '2026-10-06T00:00:00.000Z',
        total: 3,
        counts: [
          { key: 'new', count: 2 },
          { key: 'fixed', count: 1 },
        ],
      },
    ]);
  });

  it('asks the store for the caller tenant, the asset, the bucket and the hidden statuses', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await service.trend(developer, ASSET, 'week');
    expect(calls[0]).toMatchObject({
      method: 'trend',
      args: [TENANT_A, ASSET, 'week', SUSPECTED_HIDDEN],
    });
  });

  it.each([
    ['a non-UUID asset', 'asset', 'day'],
    ['an unknown bucket', ASSET, 'month'],
  ])('refuses %s', async (_label, asset, bucket) => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await expect(service.trend(analyst, asset, bucket)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('answers an empty series for an asset with no occurrences', async () => {
    const { store } = fakeStore();
    const { service } = serviceOf(store);
    expect(await service.trend(analyst, ASSET, 'day')).toEqual({
      assetId: ASSET,
      bucket: 'day',
      points: [],
    });
  });
});

describe('coverage', () => {
  /** Twelve planned test cases: nine executed (`tested`), three not run with a reason. */
  const entries = Array.from({ length: 12 }, (_, i) =>
    i < 9
      ? { testCaseRef: `tc-${i}`, status: 'tested', reason: null }
      : { testCaseRef: `tc-${i}`, status: 'not_tested', reason: 'out of scope' },
  );
  const manifest: CoverageManifestRow = {
    id: uuidOf(0x7001),
    tenantId: TENANT_A,
    publicId: null,
    runId: RUN,
    status: 'open',
    entries,
    pins: null,
    sha256: null,
    summary: null,
    finalisedAt: null,
    finalisedBy: null,
    createdAt: new Date('2026-10-29T10:00:00.000Z'),
    updatedAt: new Date('2026-10-29T10:00:00.000Z'),
  };

  it('reports a live manifest with its percentage, not finalised', async () => {
    const { store } = fakeStore({ coverageOfRun: () => Promise.resolve(manifest) });
    const { service } = serviceOf(store);
    expect(await service.coverage(analyst, { runId: RUN })).toEqual({
      runId: RUN,
      assetId: null,
      finalised: false,
      coveragePercent: 75,
      testCasesPlanned: 12,
      testCasesExecuted: 9,
      finalisedAt: null,
    });
  });

  it('reports a finalised manifest with its final instant', async () => {
    const finalised = { ...manifest, finalisedAt: new Date('2026-10-29T11:00:00.000Z') };
    const { store } = fakeStore({
      latestCoverageOfAsset: () => Promise.resolve({ runId: RUN, coverage: finalised }),
    });
    const { service } = serviceOf(store);
    const result = await service.coverage(analyst, { assetId: ASSET });
    expect(result).toMatchObject({
      finalised: true,
      finalisedAt: '2026-10-29T11:00:00.000Z',
      assetId: ASSET,
    });
  });

  it('answers finalised false with no numbers when the run has no manifest', async () => {
    const { store } = fakeStore();
    const { service } = serviceOf(store);
    expect(await service.coverage(analyst, { runId: RUN })).toEqual({
      runId: RUN,
      assetId: null,
      finalised: false,
      coveragePercent: null,
      testCasesPlanned: null,
      testCasesExecuted: null,
      finalisedAt: null,
    });
  });

  it('gives no percentage for a manifest with nothing to cover, rather than dividing by zero', async () => {
    const empty = { ...manifest, entries: [] };
    const { store } = fakeStore({ coverageOfRun: () => Promise.resolve(empty) });
    const { service } = serviceOf(store);
    expect((await service.coverage(analyst, { runId: RUN })).coveragePercent).toBeNull();
  });

  it('requires exactly one of runId and assetId', async () => {
    const { store, calls } = fakeStore();
    const { service } = serviceOf(store);
    await expect(service.coverage(analyst, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(service.coverage(analyst, { runId: RUN, assetId: ASSET })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a caller without coverage:read, and a malformed run id', async () => {
    const { store } = fakeStore();
    const { service } = serviceOf(store);
    await expect(
      service.coverage({ tenantId: TENANT_A, actorId: NOROLE_A }, { runId: RUN }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.coverage(analyst, { runId: 'run-1' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('observability', () => {
  it('logs a read slower than the threshold with its query name and tenant only', async () => {
    const clock = [0, DASHBOARD_SLOW_QUERY_MS + 40];
    const { store } = fakeStore();
    const { service, logger, observed } = serviceOf(store, {
      now: () => clock.shift() ?? 0,
    });
    await service.summary(analyst, { owaspCategories: ['A03'] });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'summary', tenantId: TENANT_A }),
      'graphql.dashboard_slow_query',
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('A03');
    expect(observed.observe).toHaveBeenCalledWith('summary', DASHBOARD_SLOW_QUERY_MS + 40, 0);
  });

  it('does not log a fast read', async () => {
    const clock = [0, 3];
    const { store } = fakeStore();
    const { service, logger } = serviceOf(store, { now: () => clock.shift() ?? 0 });
    await service.summary(analyst, {});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes the tenant it is given to the asset-name read, so a batch stays in its tenant', async () => {
    const names = vi.fn(() => Promise.resolve(new Map([[ASSET, 'Checkout']])));
    const { store } = fakeStore({ assetNames: names });
    const { service } = serviceOf(store);
    const result = await service.assetNamesOf(TENANT_B, [ASSET]);
    expect(names).toHaveBeenCalledWith(TENANT_B, [ASSET]);
    expect(result.get(ASSET)).toBe('Checkout');
  });
});
