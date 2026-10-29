import { createHash } from 'node:crypto';

import { toPublicId } from '@blackwing/ids';

import type { FindingMemberships, FindingStore } from './ports.js';
import type { Severity } from '@blackwing/contracts';
import type { FindingOccurrenceRow, FindingQuery, FindingRow } from '@blackwing/db';

const UUID_PREFIX = '0198f0a0-0000-7000-8000-';
const UUID_TAIL_WIDTH = 12;
const HEX = 16;
const MINUTE_MS = 60_000;
/** Id spaces of the fixtures: findings, occurrences and runs each keep their own range. */
const FINDING_SPACE = 0x1000;
const OCCURRENCE_SPACE = 0x2000;
const RUN_OCCURRENCE_SPACE = 0xc000;
const OCCURRENCE_STRIDE = 100;

/** A UUIDv7 with a readable tail: `uuidOf(1)` is `…-000000000001`, so fixtures stay legible in failures. */
export function uuidOf(n: number): string {
  return `${UUID_PREFIX}${n.toString(HEX).padStart(UUID_TAIL_WIDTH, '0')}`;
}

const TENANT_A_N = 0xa;
const TENANT_B_N = 0xb;
export const TENANT_A = uuidOf(TENANT_A_N);
export const TENANT_B = uuidOf(TENANT_B_N);
const APPSEC_A_N = 0xa1;
export const APPSEC_A = uuidOf(APPSEC_A_N);
const DEV_A_N = 0xa2;
export const DEV_A = uuidOf(DEV_A_N);
const AUDITOR_A_N = 0xa3;
export const AUDITOR_A = uuidOf(AUDITOR_A_N);
const NOROLE_A_N = 0xa4;
export const NOROLE_A = uuidOf(NOROLE_A_N);
const APPSEC_B_N = 0xb1;
export const APPSEC_B = uuidOf(APPSEC_B_N);

const ASSET_A_N = 0xe1;
const ASSET_A = uuidOf(ASSET_A_N);
const RUN_A_N = 0xc1;
const RUN_A = uuidOf(RUN_A_N);

/** The clock of the fixtures: row `n` was created `n` minutes after this instant. */
const EPOCH = Date.parse('2026-10-29T10:00:00.000Z');

/** A finding row of the repository's shape. Defaults make a confirmed, mapped, located finding of tenant A. */
export function findingRow(
  n: number,
  overrides: Partial<Omit<FindingRow, 'id' | 'publicId'>> & { tenantId?: string } = {},
): FindingRow {
  const id = uuidOf(FINDING_SPACE + n);
  const createdAt = new Date(EPOCH + n * MINUTE_MS);
  return {
    id,
    tenantId: TENANT_A,
    publicId: toPublicId(id, 'fnd'),
    fingerprint: createHash('sha256')
      .update(`finding-${String(n)}`)
      .digest('hex'),
    title: `Finding ${String(n)}`,
    class: 'broken_access_control',
    cweId: 'CWE-285',
    owaspCategory: 'A01',
    mappingVersion: '1.0.0',
    unmapped: false,
    classification: { cweCandidates: ['CWE-285'], apiTop10: null, wstg: [] },
    severity: null,
    assetId: ASSET_A,
    location: {
      method: 'GET',
      urlTemplate: `/admin/${String(n)}`,
      parameter: null,
      file: null,
      line: null,
    },
    status: 'confirmed',
    baselineStatus: 'new',
    runId: RUN_A,
    firstSeenRunId: RUN_A,
    lastSeenRunId: RUN_A,
    confidence: 0.9,
    acceptedRisk: null,
    releasedBy: null,
    releasedAt: null,
    createdAt,
    updatedAt: createdAt,
    stateVersion: 0,
    ...overrides,
  };
}

/** An occurrence of finding `n`, detected `k` minutes after the fixture epoch. */
export function occurrenceRow(
  findingN: number,
  k: number,
  overrides: Partial<FindingOccurrenceRow> = {},
): FindingOccurrenceRow {
  const findingId = uuidOf(FINDING_SPACE + findingN);
  const chainHead = createHash('sha256')
    .update(`chain-${String(findingN)}-${String(k)}`)
    .digest('hex');
  const bound = {
    evidenceId: uuidOf(RUN_OCCURRENCE_SPACE + findingN * OCCURRENCE_STRIDE + k),
    objectKey: `evidence/${String(findingN)}/${String(k)}.bin`,
    sha256: chainHead,
    chain: chainHead,
  };
  const base = {
    id: uuidOf(OCCURRENCE_SPACE + findingN * OCCURRENCE_STRIDE + k),
    tenantId: TENANT_A,
    findingId,
    runId: uuidOf(RUN_OCCURRENCE_SPACE + k),
    occurrenceStatus: 'observed',
    evidenceChainHead: chainHead as string | null,
    evidenceRefs: [bound],
    detectedAt: new Date(EPOCH + k * MINUTE_MS),
    createdAt: new Date(EPOCH),
    updatedAt: new Date(EPOCH),
  };
  const row = { ...base, ...overrides };
  // An occurrence with no chain head has no bound evidence either, unless the fixture says otherwise.
  if (overrides.evidenceChainHead === null && overrides.evidenceRefs === undefined) {
    return { ...row, evidenceRefs: [] };
  }
  return row;
}

/**
 * In-memory finding store with the repository's contract for the calls the service makes: the same filters, the
 * newest-first keyset on millisecond-truncated `createdAt`, and the occurrence order. Rows of other tenants are
 * filtered by `tenantOf()`, which stands in for the ambient RLS context.
 */
export function memoryFindingStore(
  rows: readonly FindingRow[],
  occurrences: readonly FindingOccurrenceRow[] = [],
  tenantOf: () => string = () => TENANT_A,
): FindingStore {
  const ms = (date: Date): number => date.getTime();
  const own = (): FindingRow[] => rows.filter((row) => row.tenantId === tenantOf());
  const compare = (a: FindingRow, b: FindingRow): number =>
    ms(b.createdAt) - ms(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  return {
    search(query: FindingQuery) {
      const matched = own()
        .filter((row) => query.assetId === undefined || row.assetId === query.assetId)
        .filter((row) => query.status === undefined || row.status === query.status)
        .filter((row) => !(query.excludeStatuses ?? []).includes(row.status))
        .filter(
          (row) =>
            query.severity === undefined ||
            (row.severity as Severity | null)?.cvss4.severity === query.severity,
        )
        .filter((row) => query.cweId === undefined || row.cweId === query.cweId)
        .filter(
          (row) => query.owaspCategory === undefined || row.owaspCategory === query.owaspCategory,
        )
        .filter(
          (row) =>
            query.baselineStatus === undefined || row.baselineStatus === query.baselineStatus,
        )
        .filter((row) => {
          if (query.after === undefined) return true;
          const at = ms(row.createdAt);
          const cut = ms(query.after.createdAt);
          return at < cut || (at === cut && row.id < query.after.id);
        })
        .sort(compare);
      return Promise.resolve(matched.slice(0, query.limit));
    },
    findById(id) {
      return Promise.resolve(own().find((row) => row.id === id));
    },
    listOccurrencesOf(findingIds) {
      const wanted = new Set(findingIds);
      const mine = occurrences.filter((o) => wanted.has(o.findingId) && o.tenantId === tenantOf());
      return Promise.resolve(
        [...mine].sort(
          (a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || (a.id < b.id ? -1 : 1),
        ),
      );
    },
    listOccurrences(findingId) {
      const mine = occurrences.filter(
        (o) => o.findingId === findingId && o.tenantId === tenantOf(),
      );
      return Promise.resolve(
        [...mine].sort(
          (a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || (a.id < b.id ? -1 : 1),
        ),
      );
    },
  };
}

/** Roles per tenant and user; a user without an entry holds no role there. */
export function memoryMemberships(
  roles: Record<string, Record<string, readonly string[]>>,
): FindingMemberships {
  return { rolesOf: (tenantId, userId) => Promise.resolve(roles[tenantId]?.[userId] ?? []) };
}
