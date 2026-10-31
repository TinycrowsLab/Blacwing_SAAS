import { describe, expect, it } from 'vitest';

import { assembleSourceSinkLeads, leadDedupKey } from './source-sink-leads.js';

import type { OpengrepMatch } from './opengrep-runner.js';

const COMMIT = 'b'.repeat(40);
const LEAD_ID = '0190f0a0-0000-7000-8000-000000000001';
const LEAD_ID_2 = '0190f0a0-0000-7000-8000-000000000002';
const ids = (...values: string[]) => {
  let i = 0;
  return () => values[i++] ?? LEAD_ID;
};

function sink(path: string, startLine: number, cweId = 'CWE-89'): OpengrepMatch {
  return {
    cweId,
    ruleId: 'bw-whitebox-cwe-89-query-concat-js',
    wstgRef: 'WSTG-INPV-05',
    owaspRef: 'A03:2021',
    location: { repoRef: 'repo:acme/shop', commitSha: COMMIT, path, startLine, endLine: startLine },
  };
}

function trace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cweId: 'CWE-89',
    source: { path: 'src/routes.ts', startLine: 10, symbol: 'handler' },
    sink: { path: 'src/db.ts', startLine: 42 },
    pathSummary: 'request parameter flows into the query text',
    confidence: 0.8,
    reachabilityHypothesis: { entrypoint: 'GET /items', roleHints: ['shopper'] },
    ...overrides,
  };
}

describe('assembleSourceSinkLeads', () => {
  it('emits exactly one lead with the correct source and sink file:line for a known path', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [trace()],
      maxLeads: 200,
      newLeadId: ids(LEAD_ID),
    });

    expect(result.discarded).toBe(0);
    expect(result.leads).toHaveLength(1);
    const [lead] = result.leads;
    expect(lead?.source).toEqual({
      repoRef: 'repo:acme/shop',
      commitSha: COMMIT,
      path: 'src/routes.ts',
      startLine: 10,
      symbol: 'handler',
    });
    expect(lead?.sink).toEqual({
      repoRef: 'repo:acme/shop',
      commitSha: COMMIT,
      path: 'src/db.ts',
      startLine: 42,
      endLine: 42,
    });
    expect(lead?.owaspRefs).toEqual(['A03:2021']);
    expect(lead?.wstgRefs).toEqual(['WSTG-INPV-05']);
    expect(lead?.confidence).toBe(0.8);
  });

  it('takes the sink location from the deterministic match, not from the model', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [
        trace({
          sink: { path: 'src/db.ts', startLine: 42 },
          source: { path: 'src/a.ts', startLine: 1, endLine: 3 },
        }),
      ],
      maxLeads: 10,
      newLeadId: ids(LEAD_ID),
    });

    expect(result.leads[0]?.sink.commitSha).toBe(COMMIT);
    expect(result.leads[0]?.source.endLine).toBe(3);
  });

  it('discards a trace whose sink is not a deterministic match (no invented sinks)', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [trace({ sink: { path: 'src/db.ts', startLine: 99 } }), trace({ cweId: 'CWE-78' })],
      maxLeads: 10,
    });

    expect(result.leads).toEqual([]);
    expect(result.discarded).toBe(2);
  });

  it('discards a trace with no sink file:line', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [trace({ sink: undefined })],
      maxLeads: 10,
    });

    expect(result.leads).toEqual([]);
    expect(result.discarded).toBe(1);
  });

  it.each([
    ['an absolute source path', { source: { path: '/etc/passwd', startLine: 1 } }],
    ['a dot-dot source path', { source: { path: '../secrets.ts', startLine: 1 } }],
    ['a confidence above 1', { confidence: 1.5 }],
    ['an unknown extra key', { payload: "' OR 1=1 --" }],
    ['a zero start line', { source: { path: 'src/routes.ts', startLine: 0 } }],
    ['a path summary above 4 KiB', { pathSummary: 'x'.repeat(4_097) }],
    [
      'an empty reachability entrypoint',
      { reachabilityHypothesis: { entrypoint: '', roleHints: [] } },
    ],
  ])('discards a trace with %s', (_label, overrides) => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [trace(overrides)],
      maxLeads: 10,
    });

    expect(result.leads).toEqual([]);
    expect(result.discarded).toBe(1);
  });

  it('keeps one lead per (cweId, sink.path, sink.startLine), the strongest, and counts the rest', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [
        trace({ confidence: 0.4, source: { path: 'src/a.ts', startLine: 1 } }),
        trace({ confidence: 0.9, source: { path: 'src/b.ts', startLine: 2 } }),
        trace({ confidence: 0.6, source: { path: 'src/c.ts', startLine: 3 } }),
      ],
      maxLeads: 10,
      newLeadId: ids(LEAD_ID),
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.source.path).toBe('src/b.ts');
    expect(result.discarded).toBe(2);
    expect(leadDedupKey('CWE-89', 'src/db.ts', 42)).toBe('CWE-89|src/db.ts|42');
  });

  it('caps leads at maxLeads and records the overflow as a coverage note instead of dropping it silently', () => {
    const matches = [sink('src/a.ts', 1), sink('src/b.ts', 2), sink('src/c.ts', 3)];
    const result = assembleSourceSinkLeads({
      matches,
      traces: [
        trace({ sink: { path: 'src/a.ts', startLine: 1 }, confidence: 0.3 }),
        trace({ sink: { path: 'src/b.ts', startLine: 2 }, confidence: 0.9 }),
        trace({ sink: { path: 'src/c.ts', startLine: 3 }, confidence: 0.5 }),
      ],
      maxLeads: 2,
      newLeadId: ids(LEAD_ID, LEAD_ID_2),
    });

    expect(result.leads.map((l) => l.sink.path)).toEqual(['src/b.ts', 'src/c.ts']);
    expect(result.coverageNotes).toContain(
      'WHITEBOX_MAX_LEADS=2 reached: 1 lower-ranked leads not emitted',
    );
  });

  it('returns zero leads and a coverage note for an empty repo or unsupported language', () => {
    const result = assembleSourceSinkLeads({ matches: [], traces: [], maxLeads: 200 });

    expect(result.leads).toEqual([]);
    expect(result.coverageNotes).toEqual([
      'no sink matches: zero leads (empty repo or unsupported language)',
    ]);
  });

  it('reports skipped files as coverage notes', () => {
    const result = assembleSourceSinkLeads({
      matches: [sink('src/db.ts', 42)],
      traces: [],
      maxLeads: 200,
      skipped: [{ path: 'dist/bundle.min.js', reason: 'exceeded max target bytes' }],
    });

    expect(result.coverageNotes).toEqual(['skipped dist/bundle.min.js: exceeded max target bytes']);
  });
});
