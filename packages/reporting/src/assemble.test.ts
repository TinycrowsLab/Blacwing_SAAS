import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { assembleReportFromSource, mapCoverage } from './assemble.js';

import type { ReportAssembleResult } from './telemetry.js';
import type { FindingRow, ReportFindingRow, ReportRunRow, ReportSource } from '@blackwing/db';

const RUN_ID = '018f0000-0000-7000-8000-0000000000aa';
const ASSET = '018f0000-0000-7000-8000-000000000001';
const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const FIXED_NOW = new Date('2026-10-30T12:00:00.000Z');

const provenance = {
  modelIds: ['claude-sonnet-4-5'],
  personaVersions: [{ persona: 'reporter', version: '1.2.0', promptSha256: SHA }],
  sdkVersion: '0.2.0',
  claudeCodeVersion: '2.1.0',
  sandboxImageDigest: DIGEST,
  toolVersions: [{ name: 'nuclei', version: '3.3.0' }],
  nucleiTemplateCommit: COMMIT,
  policyHash: SHA,
  envelopeHash: SHA,
  priceTableVersion: '2026-10',
};

const manifest = {
  mode: 'grey',
  objective: 'Check the admin area for broken access control.',
  window: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
  startedAt: '2026-10-01T01:00:00.000Z',
  endedAt: '2026-10-01T03:00:00.000Z',
  assetSummaries: [{ assetId: ASSET, label: 'shop.example.test' }],
  provenance,
};

const severity = {
  cvss4: {
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 8.7,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
};

/** A finding row with every column set; `overrides` changes exactly what a test needs. */
function findingRow(overrides: Partial<FindingRow> = {}): FindingRow {
  const base = {
    id: '018f0000-0000-7000-8000-0000000000f1',
    tenantId: '018f0000-0000-7000-8000-00000000000t',
    publicId: 'fnd_018f00000000700080000000000000f1',
    fingerprint: SHA,
    title: 'Missing authorisation on /admin',
    class: 'broken_access_control',
    cweId: 'CWE-285',
    owaspCategory: 'A01',
    mappingVersion: '1.0.0',
    unmapped: false,
    classification: null,
    severity,
    assetId: ASSET,
    location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
    status: 'released',
    baselineStatus: 'new',
    runId: RUN_ID,
    firstSeenRunId: RUN_ID,
    lastSeenRunId: RUN_ID,
    confidence: 0.92,
    acceptedRisk: null,
    releasedBy: '018f0000-0000-7000-8000-0000000000u1',
    releasedAt: new Date('2026-10-01T04:00:00.000Z'),
    description: 'The admin endpoint answers an unauthenticated request.',
    impact: 'Any visitor can read tenant configuration.',
    evidenceNarrative: 'The response contained the configuration page.',
    severityRationale: 'High confidentiality impact with no privileges required.',
    remediationSummary: 'Require the admin role on the route.',
    asvsRefs: ['ASVS v5.0.0-8.2.1'],
    createdAt: new Date('2026-10-01T02:00:00.000Z'),
    updatedAt: new Date('2026-10-01T02:00:00.000Z'),
    stateVersion: 0,
  };
  return { ...base, ...overrides } as unknown as FindingRow;
}

function releasedRow(overrides: Partial<FindingRow> = {}, severityRank = -8.7): ReportFindingRow {
  return {
    finding: findingRow(overrides),
    evidenceRefs: [],
    severityRank,
  };
}

interface FakeOptions {
  readonly run?: ReportRunRow | undefined;
  readonly coverageEntries?: unknown;
  readonly finalisedAt?: Date | null;
  readonly coverageMissing?: boolean;
  readonly released?: ReportFindingRow[];
  readonly accepted?: FindingRow[];
}

/** An in-memory report source: the caller decides which rows exist; paging follows the cursor like the database does. */
function fakeSource(options: FakeOptions = {}): ReportSource {
  const run: ReportRunRow | undefined =
    'run' in options
      ? options.run
      : { id: RUN_ID, publicId: 'run_018f0000000070008000000000000aa1', manifest: { ...manifest } };
  const coverage = options.coverageMissing
    ? undefined
    : {
        id: '018f0000-0000-7000-8000-0000000000c1',
        tenantId: '018f0000-0000-7000-8000-00000000000t',
        runId: RUN_ID,
        entries: options.coverageEntries ?? [
          { testCaseRef: 'tc_1', status: 'tested', reason: null },
        ],
        finalisedAt: options.finalisedAt === undefined ? FIXED_NOW : options.finalisedAt,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
  const released = options.released ?? [];
  const accepted = options.accepted ?? [];
  return {
    run: () => Promise.resolve(run),
    coverage: () => Promise.resolve(coverage as never),
    releasedFindings: (_runId, after, limit) => {
      const start = after
        ? released.findIndex((row) => row.finding.publicId === after.publicId) + 1
        : 0;
      return Promise.resolve(released.slice(start, start + limit));
    },
    acceptedRisks: (_runId, after, limit) => {
      const start = after ? accepted.findIndex((row) => row.publicId === after.publicId) + 1 : 0;
      return Promise.resolve(accepted.slice(start, start + limit));
    },
  };
}

describe('assembleReportFromSource: findings', () => {
  it('maps a released finding with its full write-up, severity and evidence references', async () => {
    const evidenceRefs = [
      {
        evidenceId: '018f0000-0000-7000-8000-0000000000e1',
        objectKey: 'tenants/t/evidence/e1',
        sha256: SHA,
        chain: SHA,
      },
    ];
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({ released: [{ ...releasedRow(), evidenceRefs }] }),
      { now: () => FIXED_NOW },
    );
    const [finding] = model.findings;
    expect(finding).toMatchObject({
      publicId: 'fnd_018f00000000700080000000000000f1',
      title: 'Missing authorisation on /admin',
      cweId: 'CWE-285',
      asvsRefs: ['ASVS v5.0.0-8.2.1'],
      severity: {
        cvss4Vector: severity.cvss4.vector,
        score: 8.7,
        band: 'high',
        cvss31Vector: null,
      },
      severityRationale: 'High confidentiality impact with no privileges required.',
      description: 'The admin endpoint answers an unauthenticated request.',
      impact: 'Any visitor can read tenant configuration.',
      evidenceNarrative: 'The response contained the configuration page.',
      narrativePending: false,
      evidenceRefs,
      reproArtifactRef: null,
      reproMissing: true,
      remediationSummary: 'Require the admin role on the route.',
    });
  });

  it('assembles a released finding without a write-up with null narrative and narrativePending true', async () => {
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({
        released: [
          releasedRow({
            description: null,
            impact: null,
            evidenceNarrative: null,
            severityRationale: null,
            asvsRefs: null,
            remediationSummary: null,
          }),
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(model.findings[0]).toMatchObject({
      description: null,
      impact: null,
      evidenceNarrative: null,
      severityRationale: null,
      asvsRefs: null,
      narrativePending: true,
    });
  });

  it('marks narrativePending when only part of the write-up exists', async () => {
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({ released: [releasedRow({ impact: null })] }),
      { now: () => FIXED_NOW },
    );
    expect(model.findings[0]?.narrativePending).toBe(true);
    expect(model.findings[0]?.description).toBe(
      'The admin endpoint answers an unauthenticated request.',
    );
  });

  it('carries no severity and no rationale when the finding has no CVSS vector, never a guessed score', async () => {
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({ released: [releasedRow({ severity: null })] }),
      { now: () => FIXED_NOW },
    );
    expect(model.findings[0]).toMatchObject({ severity: null, severityRationale: null });
  });

  it('treats a stored severity that no longer validates as missing rather than reporting it', async () => {
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({
        released: [releasedRow({ severity: { cvss4: { vector: 'not-a-vector', score: 99 } } })],
      }),
      { now: () => FIXED_NOW },
    );
    expect(model.findings[0]).toMatchObject({ severity: null, severityRationale: null });
  });

  it('passes the stored prose through as data, unchanged', async () => {
    const payloadLike = '<script>alert(1)</script> and "quotes" stay literal';
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({ released: [releasedRow({ description: payloadLike })] }),
      { now: () => FIXED_NOW },
    );
    expect(model.findings[0]?.description).toBe(payloadLike);
  });

  it('keeps the order the source returns and pages through every row exactly once', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      releasedRow({ publicId: `fnd_0000000000000000000000000000000${n}`, title: `finding ${n}` }),
    );
    const model = await assembleReportFromSource(RUN_ID, fakeSource({ released: rows }), {
      now: () => FIXED_NOW,
      pageSize: 2,
    });
    expect(model.findings.map((finding) => finding.title)).toEqual([
      'finding 1',
      'finding 2',
      'finding 3',
      'finding 4',
      'finding 5',
    ]);
  });

  it('states the empty list rather than hiding it when nothing was released', async () => {
    const model = await assembleReportFromSource(RUN_ID, fakeSource(), { now: () => FIXED_NOW });
    expect(model.findings).toEqual([]);
    expect(model.noReleasedFindingsNote).toBe('No findings were released for this run.');
  });
});

describe('assembleReportFromSource: accepted risks, provenance and run', () => {
  it('places accepted-risk findings in their own section, never among the findings', async () => {
    const accepted = findingRow({
      status: 'accepted_risk',
      publicId: 'fnd_018f00000000700080000000000000a1',
      acceptedRisk: {
        reason: 'Compensating control in front of the route.',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    const model = await assembleReportFromSource(RUN_ID, fakeSource({ accepted: [accepted] }), {
      now: () => FIXED_NOW,
    });
    expect(model.findings).toEqual([]);
    expect(model.acceptedRisks).toEqual([
      {
        publicId: 'fnd_018f00000000700080000000000000a1',
        title: 'Missing authorisation on /admin',
        class: 'broken_access_control',
        reason: 'Compensating control in front of the route.',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('copies the provenance block and the run identity from the run manifest', async () => {
    const model = await assembleReportFromSource(RUN_ID, fakeSource(), { now: () => FIXED_NOW });
    expect(model.provenance).toEqual(provenance);
    expect(model.run).toEqual({
      publicId: 'run_018f0000000070008000000000000aa1',
      mode: 'grey',
      objective: manifest.objective,
      assetSummaries: manifest.assetSummaries,
      window: manifest.window,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
    });
  });

  it('stamps generatedAt from the clock, and two assemblies of one snapshot differ only in that stamp', async () => {
    const source = fakeSource({ released: [releasedRow()] });
    const first = await assembleReportFromSource(RUN_ID, source, { now: () => FIXED_NOW });
    const second = await assembleReportFromSource(RUN_ID, source, {
      now: () => new Date('2026-10-30T13:00:00.000Z'),
    });
    expect(first.generatedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(second.generatedAt).toBe('2026-10-30T13:00:00.000Z');
    expect({ ...first, generatedAt: '' }).toEqual({ ...second, generatedAt: '' });
  });
});

describe('assembleReportFromSource: coverage', () => {
  it('summarises the finalised manifest: totals and not-tested reasons with their counts', async () => {
    const model = await assembleReportFromSource(
      RUN_ID,
      fakeSource({
        coverageEntries: [
          { testCaseRef: 'tc_1', status: 'tested', reason: null },
          { testCaseRef: 'tc_2', status: 'not_tested', reason: 'model_declined' },
          { testCaseRef: 'tc_3', status: 'not_tested', reason: 'egress_blocked' },
          { testCaseRef: 'tc_4', status: 'not_tested', reason: 'model_declined' },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(model.coverage).toEqual({
      finalisedAt: FIXED_NOW.toISOString(),
      totalTestCases: 4,
      tested: 1,
      notTested: 3,
      notTestedReasons: { egress_blocked: 1, model_declined: 2 },
    });
  });

  it('counts an empty manifest as zero cases, still valid', () => {
    expect(mapCoverage([], FIXED_NOW.toISOString())).toEqual({
      finalisedAt: FIXED_NOW.toISOString(),
      totalTestCases: 0,
      tested: 0,
      notTested: 0,
      notTestedReasons: {},
    });
  });
});

describe('assembleReportFromSource: refusals', () => {
  const assemble = (source: ReportSource) =>
    assembleReportFromSource(RUN_ID, source, { now: () => FIXED_NOW });

  it('reads an unknown run as not found', async () => {
    await expect(assemble(fakeSource({ run: undefined }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads a malformed run id as not found, before it reaches the database', async () => {
    await expect(
      assembleReportFromSource('not-a-uuid', fakeSource(), { now: () => FIXED_NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a run that has no public id yet', async () => {
    const run = { id: RUN_ID, publicId: null, manifest: { ...manifest } };
    await expect(assemble(fakeSource({ run }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a run whose manifest is missing or incomplete (§8.9 pinned versions)', async () => {
    const missing = {
      id: RUN_ID,
      publicId: 'run_018f0000000070008000000000000aa1',
      manifest: null,
    };
    await expect(assemble(fakeSource({ run: missing }))).rejects.toBeInstanceOf(ConflictError);
    const incomplete = {
      id: RUN_ID,
      publicId: 'run_018f0000000070008000000000000aa1',
      manifest: { ...manifest, provenance: { ...provenance, policyHash: undefined } },
    };
    await expect(assemble(fakeSource({ run: incomplete }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses when the coverage manifest is missing (F19: no export without it)', async () => {
    await expect(assemble(fakeSource({ coverageMissing: true }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses when the coverage manifest is not finalised', async () => {
    await expect(assemble(fakeSource({ finalisedAt: null }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a stored coverage entry that is not-tested without a reason', async () => {
    await expect(
      assemble(
        fakeSource({
          coverageEntries: [{ testCaseRef: 'tc_1', status: 'not_tested', reason: null }],
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a stored location that no longer parses, rather than reporting a guessed one', async () => {
    await expect(
      assemble(fakeSource({ released: [releasedRow({ location: { urlTemplate: 7 } })] })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an invalid page size', async () => {
    await expect(
      assembleReportFromSource(RUN_ID, fakeSource(), { pageSize: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      assembleReportFromSource(RUN_ID, fakeSource(), { pageSize: 501 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assembleReportFromSource: observability', () => {
  it('records the outcome of each assembly', async () => {
    const results: ReportAssembleResult[] = [];
    const metrics = {
      assembled: (result: ReportAssembleResult) => results.push(result),
      durationMs: () => undefined,
    };
    await assembleReportFromSource(RUN_ID, fakeSource(), { now: () => FIXED_NOW, metrics });
    await expect(
      assembleReportFromSource(RUN_ID, fakeSource({ run: undefined }), { metrics }),
    ).rejects.toThrow();
    await expect(
      assembleReportFromSource(RUN_ID, fakeSource({ coverageMissing: true }), { metrics }),
    ).rejects.toThrow();
    expect(results).toEqual(['ok', 'not_found', 'refused']);
  });
});
