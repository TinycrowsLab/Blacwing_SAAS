import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { toPublicId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import {
  APPSEC_A,
  AUDITOR_A,
  DEV_A,
  NOROLE_A,
  TENANT_A,
  findingRow,
  memoryFindingStore,
  memoryMemberships,
  occurrenceRow,
  uuidOf,
} from './fixtures.test-helpers.js';
import { createCedarFindingPolicy } from './policy.js';
import { parseFindingListQuery } from './query.js';
import { FindingService, type FindingServiceDeps, type FindingPrincipal } from './service.js';
import { createCursorCodec } from '../pagination/index.js';

import type { FindingRow } from '@blackwing/db';

const SECRET = 'x'.repeat(40);
const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });

/** Suspected finding 3 is the only one an analyst alone may read. Findings 1..6 are otherwise confirmed. */
function rows(): FindingRow[] {
  return [1, 2, 3, 4, 5, 6].map((n) =>
    findingRow(n, n === 3 ? { status: 'suspected', severity: null } : {}),
  );
}

function serviceFor(
  options: {
    readonly rows?: readonly FindingRow[];
    readonly occurrences?: Parameters<typeof memoryFindingStore>[1];
    readonly roles?: Record<string, Record<string, readonly string[]>>;
  } = {},
) {
  const metrics = { request: vi.fn() };
  const deps: FindingServiceDeps = {
    store: memoryFindingStore(options.rows ?? rows(), options.occurrences ?? []),
    memberships: memoryMemberships(
      options.roles ?? {
        [TENANT_A]: {
          [APPSEC_A]: ['appsec_engineer'],
          [DEV_A]: ['developer'],
          [AUDITOR_A]: ['auditor'],
        },
      },
    ),
    policy: createCedarFindingPolicy(),
    cursors: createCursorCodec(SECRET),
    metrics,
    logger,
  };
  return { service: new FindingService(deps), metrics };
}

const principal = (actorId: string, tenantId = TENANT_A): FindingPrincipal => ({
  tenantId,
  actorId,
});
const query = (raw: Record<string, unknown> = {}) => parseFindingListQuery(raw);

/** The wire code of a refused call. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (
      (error as { problemCode?: string; code?: string }).problemCode ??
      (error as { code?: string }).code ??
      'unknown'
    );
  }
  throw new Error('expected a refusal');
}

describe('FindingService.list', () => {
  it('refuses a caller with no finding:read permission (403)', async () => {
    const { service } = serviceFor();
    await expect(service.list(principal(NOROLE_A), query())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lists every non-suspected finding of the tenant to a developer and hides the suspected one', async () => {
    const { service } = serviceFor();
    const page = await service.list(principal(DEV_A), query({ limit: '50' }));
    expect(page.items.map((item) => item.status)).not.toContain('suspected');
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('shows the suspected finding to an AppSec analyst', async () => {
    const { service } = serviceFor();
    const page = await service.list(principal(APPSEC_A), query({ status: 'suspected' }));
    expect(page.items.map((item) => item.status)).toEqual(['suspected']);
  });

  it('answers an empty page, not an error, when a non-analyst filters on suspected', async () => {
    const { service } = serviceFor();
    expect(await service.list(principal(DEV_A), query({ status: 'suspected' }))).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('filters by asset, status, severity band, CWE, OWASP and baseline, combined with AND', async () => {
    const scored = rows().map((row) =>
      row.id === findingRow(1).id
        ? {
            ...row,
            severity: {
              cvss4: {
                vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
                score: 9.3,
                severity: 'critical' as const,
                nomenclature: 'CVSS-B' as const,
              },
            },
            baselineStatus: 'fixed' as const,
          }
        : row,
    );
    const { service } = serviceFor({ rows: scored });
    const bySeverity = await service.list(principal(DEV_A), query({ severity: 'critical' }));
    expect(bySeverity.items.map((i) => i.title)).toEqual(['Finding 1']);
    const byBaseline = await service.list(principal(DEV_A), query({ baselineStatus: 'fixed' }));
    expect(byBaseline.items).toHaveLength(1);
    const byCwe = await service.list(principal(DEV_A), query({ cwe: 'CWE-89' }));
    expect(byCwe.items).toEqual([]);
    const byAsset = await service.list(
      principal(DEV_A),
      query({ assetId: '0198f0a0-0000-7000-8000-0000000000e1' }),
    );
    expect(byAsset.items).toHaveLength(5);
  });

  it('pages with an opaque cursor: pages concatenate to the unpaged list, with no duplicate or gap', async () => {
    const { service } = serviceFor();
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await service.list(
        principal(DEV_A),
        query({ limit: '2', ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      guard += 1;
    } while (cursor !== undefined && guard < 10);
    const all = await service.list(principal(DEV_A), query({ limit: '200' }));
    expect(seen).toEqual(all.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor that was issued for other filters (invalid_cursor)', async () => {
    const { service } = serviceFor();
    const first = await service.list(principal(DEV_A), query({ limit: '2' }));
    expect(first.nextCursor).not.toBeNull();
    const replay = service.list(
      principal(DEV_A),
      query({ limit: '2', status: 'released', cursor: first.nextCursor ?? '' }),
    );
    expect(await codeOf(replay)).toBe('invalid_cursor');
  });

  it('refuses a cursor from an analyst view when a developer replays it (visibility is bound)', async () => {
    const { service } = serviceFor();
    const analystPage = await service.list(principal(APPSEC_A), query({ limit: '2' }));
    expect(analystPage.nextCursor).not.toBeNull();
    const replay = service.list(
      principal(DEV_A),
      query({ limit: '2', cursor: analystPage.nextCursor ?? '' }),
    );
    expect(await codeOf(replay)).toBe('invalid_cursor');
  });

  it('refuses a forged or tampered cursor (invalid_cursor)', async () => {
    const { service } = serviceFor();
    const forged = service.list(principal(DEV_A), query({ cursor: 'AAAA.BBBB' }));
    expect(await codeOf(forged)).toBe('invalid_cursor');
  });

  it('refuses a cursor signed with another key (invalid_cursor, fail closed)', async () => {
    const other = createCursorCodec('y'.repeat(40));
    const token = other.encode({
      k: [new Date().toISOString(), uuidOf(0x1005)],
      d: 'desc',
      s: 'x',
    });
    const { service } = serviceFor();
    expect(await codeOf(service.list(principal(DEV_A), query({ cursor: token })))).toBe(
      'invalid_cursor',
    );
  });

  it('answers an empty list and a null cursor for a tenant with no findings', async () => {
    const { service } = serviceFor({ rows: [] });
    expect(await service.list(principal(DEV_A), query())).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('records the request on the finding metric by route and result', async () => {
    const { service, metrics } = serviceFor();
    await service.list(principal(DEV_A), query());
    expect(metrics.request).toHaveBeenCalledWith('list', 'ok');
    await expect(service.list(principal(NOROLE_A), query())).rejects.toThrow();
    expect(metrics.request).toHaveBeenCalledWith('list', 'denied');
  });
});

describe('FindingService.get', () => {
  it('returns the summary with mapping, severity, baseline, confidence and evidence refs', async () => {
    const target = nth(rows(), 0);
    const { service } = serviceFor({
      occurrences: [occurrenceRow(1, 1), occurrenceRow(1, 2, { evidenceChainHead: null })],
    });
    const detail = await service.get(principal(DEV_A), target.publicId);
    expect(detail.id).toBe(target.publicId);
    expect(detail.cweId).toBe('CWE-285');
    expect(detail.owaspCategory).toBe('A01');
    expect(detail.mappingVersion).toBe('1.0.0');
    expect(detail.confidence).toBe(0.9);
    expect(detail.baselineStatus).toBe('new');
    expect(detail.occurrences.total).toBe(2);
    expect(detail.occurrences.items).toHaveLength(2);
    expect(detail.evidence.total).toBe(1);
    expect(detail.evidence.items[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.occurrences.truncated).toBe(false);
  });

  it('answers a finding with no occurrences yet with an empty list, not an error', async () => {
    const target = nth(rows(), 0);
    const { service } = serviceFor({ occurrences: [] });
    const detail = await service.get(principal(DEV_A), target.publicId);
    expect(detail.occurrences).toEqual({ items: [], total: 0, truncated: false });
    expect(detail.evidence).toEqual({ items: [], total: 0, truncated: false });
  });

  it('bounds the inlined occurrences and evidence refs at 50 and flags the rest as truncated', async () => {
    const target = nth(rows(), 0);
    const many = Array.from({ length: 60 }, (_, k) => occurrenceRow(1, k + 1));
    const { service } = serviceFor({ occurrences: many });
    const detail = await service.get(principal(DEV_A), target.publicId);
    expect(detail.occurrences.items).toHaveLength(50);
    expect(detail.occurrences.total).toBe(60);
    expect(detail.occurrences.truncated).toBe(true);
    expect(detail.evidence.items).toHaveLength(50);
    expect(detail.evidence.total).toBe(60);
    expect(detail.evidence.truncated).toBe(true);
  });

  it('answers a suspected finding to an analyst', async () => {
    const suspected = nth(rows(), 2);
    const { service } = serviceFor();
    expect((await service.get(principal(APPSEC_A), suspected.publicId)).status).toBe('suspected');
  });

  it('answers a suspected finding to a developer with the same 404 as a missing one (F17, no existence leak)', async () => {
    const suspected = nth(rows(), 2);
    const { service } = serviceFor();
    const hidden = await codeOfNotFound(service.get(principal(DEV_A), suspected.publicId));
    const missing = await codeOfNotFound(
      service.get(principal(DEV_A), toPublicId(uuidOf(0x9999), 'fnd')),
    );
    expect(hidden).toBe(missing);
  });

  it('answers 404 for a malformed id, a foreign tenant finding and a missing one alike', async () => {
    const foreign = findingRow(9, { tenantId: uuidOf(0xb) });
    const { service } = serviceFor({ rows: [...rows(), foreign] });
    await expect(service.get(principal(DEV_A), 'not-a-finding')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.get(principal(DEV_A), foreign.publicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.get(principal(DEV_A), toPublicId(uuidOf(0x7777), 'fnd')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a caller with no finding:read permission before it reads the finding (403)', async () => {
    const { service } = serviceFor();
    await expect(service.get(principal(NOROLE_A), nth(rows(), 0).publicId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('lets an auditor read a non-suspected finding (read-only role)', async () => {
    const { service } = serviceFor();
    expect((await service.get(principal(AUDITOR_A), nth(rows(), 0).publicId)).title).toBe(
      'Finding 1',
    );
  });
});

async function codeOfNotFound(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NotFoundError) return error.message;
    throw error;
  }
  throw new Error('expected a 404');
}

/** The element at `index` of a fixture list, which the fixture knows is there. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no fixture at index ${String(index)}`);
  return item;
}
