// Reference-data access for the vulnerability-intelligence mirror (INTEL-001, CONTEXT_PACK §7, §8.6). The mirror is
// global and tenant-less, so these functions take the database directly rather than `withTenant`. Writes belong to the
// ingestion role (INTEL-002..006): the runtime role `bw_app` only reads these tables (see the intel migration), so these
// writers run on the owner pool. Every record is parsed with the domain schema before it is written.

import { count, sql } from 'drizzle-orm';

import { cveRecordSchema, type CveRecord } from '@blackwing/domain';

import {
  cveRecords,
  cweCatalogue,
  epssScores,
  kevEntries,
  osvAdvisories,
  owaspMappings,
  sourceSyncState,
} from './schema/intel.js';

import type { Database } from './client.js';

/** The reference tables the row-count metric reports (`intel_mirror_rows{table}`). `finding_intel` is tenant data and is not counted here. */
const INTEL_MIRROR_TABLES = {
  cve_records: cveRecords,
  kev_entries: kevEntries,
  epss_scores: epssScores,
  osv_advisories: osvAdvisories,
  cwe_catalogue: cweCatalogue,
  owasp_mappings: owaspMappings,
  source_sync_state: sourceSyncState,
} as const;

export type IntelMirrorTable = keyof typeof INTEL_MIRROR_TABLES;

/** Row count of every reference table, read as `bw_app` (SELECT only) or the owner. */
export async function countIntelMirrorRows(
  db: Database,
): Promise<Record<IntelMirrorTable, number>> {
  const entries = Object.entries(INTEL_MIRROR_TABLES) as [
    IntelMirrorTable,
    (typeof INTEL_MIRROR_TABLES)[IntelMirrorTable],
  ][];
  const counts = await Promise.all(
    entries.map(async ([, table]) => {
      const [row] = await db.select({ rows: count() }).from(table);
      return row?.rows ?? 0;
    }),
  );
  return Object.fromEntries(entries.map(([name], index) => [name, counts[index] ?? 0])) as Record<
    IntelMirrorTable,
    number
  >;
}

/** Newer `sourceUpdated` wins; a record without one loses to any record that has one. Ties go to the later record. */
function newerOf(current: CveRecord, candidate: CveRecord): CveRecord {
  const a = current.sourceUpdated?.getTime() ?? Number.NEGATIVE_INFINITY;
  const b = candidate.sourceUpdated?.getTime() ?? Number.NEGATIVE_INFINITY;
  return b >= a ? candidate : current;
}

/**
 * Upserts CVE records by `cve_id` (the duplicate-source rule of INTEL-001). Within one batch the newest record per CVE
 * wins before the write, because one statement cannot touch the same row twice. On conflict the stored row is replaced
 * only when the incoming `source_updated` is equal or newer, so re-running a sync is idempotent and never regresses.
 * Returns the number of records submitted (after the in-batch merge).
 */
export async function upsertCveRecords(db: Database, records: readonly unknown[]): Promise<number> {
  const merged = new Map<string, CveRecord>();
  for (const raw of records) {
    const record = cveRecordSchema.parse(raw);
    const current = merged.get(record.cveId);
    merged.set(record.cveId, current ? newerOf(current, record) : record);
  }
  const rows = [...merged.values()].map((record) => ({
    cveId: record.cveId,
    published: record.published,
    lastModified: record.lastModified,
    cvssV31: record.cvssV31,
    cvssV40: record.cvssV40,
    cweIds: record.cweIds,
    cpeMatches: record.cpeMatches,
    description: record.description,
    sourceUpdated: record.sourceUpdated,
  }));
  if (rows.length === 0) return 0;
  await db
    .insert(cveRecords)
    .values(rows)
    .onConflictDoUpdate({
      target: cveRecords.cveId,
      set: {
        published: sql`excluded.published`,
        lastModified: sql`excluded.last_modified`,
        cvssV31: sql`excluded.cvss_v31`,
        cvssV40: sql`excluded.cvss_v40`,
        cweIds: sql`excluded.cwe_ids`,
        cpeMatches: sql`excluded.cpe_matches`,
        description: sql`excluded.description`,
        sourceUpdated: sql`excluded.source_updated`,
      },
      setWhere: sql`excluded.source_updated >= ${cveRecords.sourceUpdated} OR ${cveRecords.sourceUpdated} IS NULL`,
    });
  return rows.length;
}
