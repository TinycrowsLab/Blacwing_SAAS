import { describe, expect, it } from 'vitest';

import {
  coverageEntrySchema,
  REPORT_SCHEMA_VERSION,
  reportModelSchema,
  runManifestSchema,
} from './report.js';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const ASSET = '018f0000-0000-7000-8000-000000000001';

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

describe('runManifestSchema', () => {
  it('accepts a complete manifest', () => {
    expect(runManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('refuses a manifest with a missing pinned version (§8.9 pinned versions)', () => {
    const partial: Record<string, unknown> = { ...provenance };
    delete partial.envelopeHash;
    expect(runManifestSchema.safeParse({ ...manifest, provenance: partial }).success).toBe(false);
  });

  it('refuses a sandbox digest that is not a sha256 digest', () => {
    const bad = { ...manifest, provenance: { ...provenance, sandboxImageDigest: 'latest' } };
    expect(runManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('coverageEntrySchema', () => {
  it('requires a reason for a not-tested case and forbids one for a tested case', () => {
    expect(
      coverageEntrySchema.safeParse({ testCaseRef: 'tc_1', status: 'not_tested', reason: null })
        .success,
    ).toBe(false);
    expect(
      coverageEntrySchema.safeParse({ testCaseRef: 'tc_1', status: 'tested', reason: 'x' }).success,
    ).toBe(false);
    expect(
      coverageEntrySchema.safeParse({
        testCaseRef: 'tc_1',
        status: 'not_tested',
        reason: 'model_declined',
      }).success,
    ).toBe(true);
  });
});

describe('reportModelSchema', () => {
  const model = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: '2026-10-30T00:00:00.000Z',
    run: {
      publicId: 'run_018f0000000070008000000000000001',
      mode: 'grey',
      objective: manifest.objective,
      assetSummaries: manifest.assetSummaries,
      window: manifest.window,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
    },
    provenance,
    noReleasedFindingsNote: 'No findings were released for this run.',
    findings: [],
    acceptedRisks: [],
    coverage: {
      finalisedAt: '2026-10-30T00:00:00.000Z',
      totalTestCases: 0,
      tested: 0,
      notTested: 0,
      notTestedReasons: {},
    },
  };

  it('accepts an empty report that states why it is empty', () => {
    expect(reportModelSchema.safeParse(model).success).toBe(true);
  });

  it('refuses an unknown schema version and any extra top-level field', () => {
    expect(reportModelSchema.safeParse({ ...model, schemaVersion: 2 }).success).toBe(false);
    expect(reportModelSchema.safeParse({ ...model, exploit: 'x' }).success).toBe(false);
  });
});
