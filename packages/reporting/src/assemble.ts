// Report assembly (REPORT-001, CONTEXT_PACK §3.2, §8.6, §8.9). `assembleReport` gathers one run's released findings,
// their reporter write-up, the finalised coverage manifest, the run provenance and the accepted-risk section into one
// `ReportModel`. Every export format renders from that model, so PDF, JSON and SARIF cannot diverge.
//
// Fail closed: a run without a manifest, a coverage manifest that is missing or not finalised, or a stored row that no
// longer parses refuses the assembly. Nothing is guessed; a missing CVSS vector or write-up is null and says so.

import { performance } from 'node:perf_hooks';

import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { z } from 'zod';

import {
  acceptedRiskSchema,
  coverageEntrySchema,
  type CoverageEntry,
  type CoverageSummary,
  type ReportAcceptedRisk,
  type ReportFinding,
  type ReportModel,
  REPORT_MAX_TEST_CASES,
  REPORT_SCHEMA_VERSION,
  reportFindingSchema,
  reportModelSchema,
  type RunManifest,
  runManifestSchema,
  findingLocationSchema,
  severitySchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import {
  type AcceptedRiskCursor,
  type Database,
  type ReleasedCursor,
  type ReportFindingRow,
  type ReportSource,
  type FindingRow,
  withReportSource,
} from '@blackwing/db';
import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import {
  log,
  noopReportMetrics,
  tracer,
  type ReportAssembleResult,
  type ReportMetrics,
} from './telemetry.js';

/** Largest page one assembly reads at a time; a larger finding set is paged, never loaded whole. */
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

/** Shown when the run released nothing: the empty list is stated, not silent. */
const NO_RELEASED_FINDINGS_NOTE = 'No findings were released for this run.';

export interface AssembleReportSourceOptions {
  /** Clock for `generatedAt`. Tests pass a fixed clock; the default is the system time. */
  readonly now?: () => Date;
  /** Rows read per page (1 to 500). */
  readonly pageSize?: number;
  readonly metrics?: ReportMetrics;
}

export interface AssembleReportOptions extends AssembleReportSourceOptions {
  readonly db: Database;
  /** The tenant the run belongs to. RLS hides every other tenant's run, so a foreign run id reads as not found. */
  readonly tenantId: string;
}

/**
 * Assembles the report for one run, as one tenant-scoped snapshot. Throws `NotFoundError` for an unknown run (or one
 * of another tenant) and `ConflictError` when the run cannot be reported yet (no manifest, no finalised coverage,
 * or a stored row that no longer parses).
 */
export function assembleReport(
  runId: string,
  options: AssembleReportOptions,
): Promise<ReportModel> {
  return withReportSource(options.db, options.tenantId, (source) =>
    assembleReportFromSource(runId, source, options),
  );
}

/**
 * Assembles the report from a report source the caller has already opened (one snapshot). `assembleReport` is this
 * with the source opened for it; tests drive it with an in-memory source.
 */
export async function assembleReportFromSource(
  runId: string,
  source: ReportSource,
  options: AssembleReportSourceOptions = {},
): Promise<ReportModel> {
  const metrics = options.metrics ?? noopReportMetrics;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError('invalid report page size', {
      detail: `pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}.`,
    });
  }
  const span = tracer.startSpan('report.assemble', { attributes: { 'report.run_id': runId } });
  const started = performance.now();
  let result: ReportAssembleResult = 'error';
  try {
    const model = await build(runId, source, { ...options, pageSize });
    result = 'ok';
    span.setAttribute('report.run_public_id', model.run.publicId);
    log.info(
      {
        runPublicId: model.run.publicId,
        releasedFindingCount: model.findings.length,
        narrativePendingCount: model.findings.filter((finding) => finding.narrativePending).length,
      },
      'report assembled',
    );
    return model;
  } catch (error) {
    result = resultFor(error);
    recordFailure(span, error);
    throw error;
  } finally {
    metrics.assembled(result);
    metrics.durationMs(performance.now() - started);
    span.end();
  }
}

function resultFor(error: unknown): ReportAssembleResult {
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof ConflictError) return 'refused';
  return 'error';
}

function recordFailure(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: resultFor(error) });
}

async function build(
  runId: string,
  source: ReportSource,
  options: AssembleReportSourceOptions & { readonly pageSize: number },
): Promise<ReportModel> {
  const clock = options.now ?? (() => new Date());
  // A malformed id cannot name a run of any tenant: it reads as not found, before it reaches Postgres.
  if (!uuidV7Schema.safeParse(runId).success) {
    throw new NotFoundError('run not found');
  }

  const run = await source.run(runId);
  if (!run) {
    throw new NotFoundError('run not found');
  }
  if (run.publicId === null) {
    throw new ConflictError('run is not ready for a report', {
      detail: 'The run has no public id yet.',
    });
  }
  const manifest: RunManifest = parseStored(runManifestSchema, run.manifest, 'run manifest');

  const coverage = await source.coverage(runId);
  if (!coverage?.finalisedAt) {
    throw new ConflictError('coverage manifest is not finalised', {
      detail: 'A report needs the finalised coverage manifest (F19).',
    });
  }
  const entries = parseStored(
    z.array(coverageEntrySchema).max(REPORT_MAX_TEST_CASES),
    coverage.entries,
    'coverage manifest',
  );

  const findingsOut: ReportFinding[] = [];
  let releasedCursor: ReleasedCursor | null = null;
  for (;;) {
    const page: ReportFindingRow[] = await source.releasedFindings(
      runId,
      releasedCursor,
      options.pageSize,
    );
    for (const row of page) {
      findingsOut.push(mapReportFinding(row));
    }
    const last = page.at(-1);
    if (page.length < options.pageSize || !last) break;
    releasedCursor = {
      severityRank: last.severityRank,
      class: last.finding.class,
      publicId: last.finding.publicId,
    };
  }

  const acceptedOut: ReportAcceptedRisk[] = [];
  let acceptedCursor: AcceptedRiskCursor | null = null;
  for (;;) {
    const page: FindingRow[] = await source.acceptedRisks(runId, acceptedCursor, options.pageSize);
    for (const row of page) {
      acceptedOut.push(mapAcceptedRisk(row));
    }
    const last = page.at(-1);
    if (page.length < options.pageSize || !last) break;
    acceptedCursor = { publicId: last.publicId };
  }

  const model: ReportModel = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: clock().toISOString(),
    run: {
      publicId: run.publicId,
      mode: manifest.mode,
      objective: manifest.objective,
      assetSummaries: manifest.assetSummaries,
      window: manifest.window,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
    },
    provenance: manifest.provenance,
    noReleasedFindingsNote: findingsOut.length === 0 ? NO_RELEASED_FINDINGS_NOTE : null,
    findings: findingsOut,
    acceptedRisks: acceptedOut,
    coverage: mapCoverage(entries, coverage.finalisedAt.toISOString()),
  };
  return reportModelSchema.parse(model);
}

/**
 * One released finding as the report shows it. The reporter's write-up is taken from the stored finding as it is; a
 * field the reporter has not written is null, and `narrativePending` is true while any of the three core prose fields
 * (`description`, `impact`, `evidenceNarrative`) is missing. A finding with no usable CVSS vector carries no severity
 * and no severity rationale, rather than a guessed score.
 */
function mapReportFinding(row: ReportFindingRow): ReportFinding {
  const finding = row.finding;
  const severity = storedSeverity(finding);
  const narrativePending =
    finding.description === null || finding.impact === null || finding.evidenceNarrative === null;
  const location = parseStored(findingLocationSchema, finding.location, 'finding location');
  return reportFindingSchema.parse({
    publicId: finding.publicId,
    title: finding.title,
    class: finding.class,
    cweId: finding.cweId,
    owaspCategory: finding.owaspCategory,
    asvsRefs: finding.asvsRefs,
    severity,
    severityRationale: severity === null ? null : finding.severityRationale,
    location,
    baselineStatus: finding.baselineStatus,
    confidence: finding.confidence,
    description: finding.description,
    impact: finding.impact,
    evidenceNarrative: finding.evidenceNarrative,
    narrativePending,
    evidenceRefs: row.evidenceRefs,
    reproArtifactRef: null,
    reproMissing: true,
    remediationSummary: finding.remediationSummary,
  });
}

/** An accepted-risk finding for its own labelled section. The reason and expiry come from the triage record. */
function mapAcceptedRisk(finding: FindingRow): ReportAcceptedRisk {
  const risk = parseStored(acceptedRiskSchema, finding.acceptedRisk, 'accepted risk');
  return {
    publicId: finding.publicId,
    title: finding.title,
    class: finding.class,
    reason: risk.reason,
    expiresAt: risk.expiresAt,
  };
}

/**
 * The coverage summary (F19): how many test cases ran, how many did not, and why. Reasons are counted and keyed in
 * sorted order, so two assemblies of one manifest produce the same summary.
 */
export function mapCoverage(
  entries: readonly CoverageEntry[],
  finalisedAt: string,
): CoverageSummary {
  const counts = new Map<string, number>();
  let tested = 0;
  let notTested = 0;
  for (const entry of entries) {
    if (entry.status === 'tested') {
      tested += 1;
      continue;
    }
    notTested += 1;
    if (entry.reason !== null) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
  }
  const notTestedReasons = Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    finalisedAt,
    totalTestCases: entries.length,
    tested,
    notTested,
    notTestedReasons,
  };
}

/** The finding's CVSS v4.0 severity as the report shows it, or null when no valid vector was stored. */
function storedSeverity(finding: FindingRow): ReportFinding['severity'] {
  const parsed = severitySchema.safeParse(finding.severity);
  if (!parsed.success) {
    // A stored severity that no longer validates is treated as missing, never guessed. The write path enforces the
    // shape, so this is a data-quality signal worth a log line.
    if (finding.severity !== null) {
      log.warn(
        { findingPublicId: finding.publicId },
        'stored severity did not validate; reported as missing',
      );
    }
    return null;
  }
  return {
    cvss4Vector: parsed.data.cvss4.vector,
    score: parsed.data.cvss4.score,
    band: parsed.data.cvss4.severity,
    cvss31Vector: parsed.data.cvss31?.vector ?? null,
  };
}

/** Parses a stored value, refusing the assembly when it no longer matches its contract. Field paths only, no values. */
function parseStored<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ConflictError(`${what} is not reportable`, {
      detail: `Invalid ${what}: ${fields.join(', ')}.`,
    });
  }
  return result.data;
}
