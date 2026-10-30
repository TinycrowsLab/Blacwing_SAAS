// Vulnerability-intelligence mirror: the shared values (INTEL-001, CONTEXT_PACK §7, §8.6, §8.9). The database CHECK
// constraints (packages/db/src/schema/intel.ts) and the domain read models (packages/domain/src/intel) both read these,
// so the two sides cannot drift. The mirror holds global reference data; only `finding_intel` is tenant-scoped.

import { z } from 'zod';

/** OWASP standards a CWE or finding can be mapped to (REFERENCES §6). */
export const OWASP_SCHEMES = ['top10_2021', 'api_top10_2023'] as const;
export const owaspSchemeSchema = z.enum(OWASP_SCHEMES);

/** The upstream feeds the mirror ingests (REFERENCES §6). One `source_sync_state` row per source. */
export const INTEL_SOURCES = [
  'nvd',
  'cisa_kev',
  'first_epss',
  'osv',
  'ghsa',
  'mitre_cwe',
  'owasp',
] as const;
export const intelSourceSchema = z.enum(INTEL_SOURCES);

/** Lifecycle of one incremental sync run. */
export const SOURCE_SYNC_STATUSES = ['idle', 'running', 'succeeded', 'failed'] as const;
export const sourceSyncStatusSchema = z.enum(SOURCE_SYNC_STATUSES);

/** `CVE-<year>-<number>` (the number has at least four digits). */
export const CVE_ID_PATTERN = /^CVE-[0-9]{4}-[0-9]{4,}$/;
export const cveIdSchema = z.string().regex(CVE_ID_PATTERN, 'must look like CVE-<year>-<number>');

/** `GHSA-xxxx-xxxx-xxxx` (lowercase alphanumerics), as OSV and GitHub Advisory Database use it. */
export const GHSA_ID_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
export const ghsaIdSchema = z.string().regex(GHSA_ID_PATTERN, 'must look like GHSA-xxxx-xxxx-xxxx');

/**
 * Size and length limits of the mirror, shared by the database CHECKs and the domain read models. One object, so the two
 * sides cannot disagree. Byte caps are on the JSON serialisation; refused records are never truncated (fail closed).
 */
export const INTEL_LIMITS = Object.freeze({
  /** Byte cap on the `cpe_matches` jsonb of one CVE record. */
  cpeMatchesBytes: 65_536,
  /** Entry cap on the `cpe_matches` array of one CVE record. */
  cpeMatchEntries: 10_000,
  /** Byte cap on `osv_advisories.affected_ranges` / `severity` and `cwe_catalogue.relationships`. */
  jsonBytes: 65_536,
  /** Character cap on a CVE description. */
  cveDescriptionChars: 16_384,
  /** Character cap on free-text sync errors and KEV notes. */
  syncErrorChars: 2_000,
  /** Upper bound on CWE ids stored on one record. */
  cweIds: 32,
  /** Character cap on a CVSS vector string. */
  cvssVectorChars: 256,
  /** OSV advisory aliases: count and length per alias. */
  osvAliases: 32,
  osvAliasChars: 64,
  /** OSV advisory identifier length. */
  osvIdChars: 128,
  /** Ecosystem and package names. */
  ecosystemChars: 64,
  packageChars: 256,
  /** CWE name and abstraction labels. */
  cweNameChars: 512,
  cweAbstractionChars: 32,
  /** OWASP category code and title. */
  owaspCodeChars: 16,
  owaspTitleChars: 256,
  /** Opaque incremental-sync cursor. */
  cursorChars: 1_024,
});

export const CPE_MATCHES_MAX_BYTES = INTEL_LIMITS.cpeMatchesBytes;
/** Byte cap on `osv_advisories.affected_ranges` and `cwe_catalogue.relationships`. */
export const INTEL_JSON_MAX_BYTES = INTEL_LIMITS.jsonBytes;
/** Character cap on a CVE description. */
export const CVE_DESCRIPTION_MAX_CHARS = INTEL_LIMITS.cveDescriptionChars;
/** Character cap on a `source_sync_state.last_error`. */
export const SYNC_ERROR_MAX_CHARS = INTEL_LIMITS.syncErrorChars;
/** Upper bound on CWE ids stored on one record. */
export const INTEL_CWE_IDS_MAX = INTEL_LIMITS.cweIds;
