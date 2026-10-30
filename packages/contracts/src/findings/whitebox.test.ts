import { describe, expect, expectTypeOf, it } from 'vitest';

import { brokerCandidateRequestSchema } from '../broker.js';
import {
  CodeEvidenceSchema,
  type CodeLocation,
  CodeLocationSchema,
  type CodePlusRuntimeOracle,
  CodePlusRuntimeOracleSchema,
  PATH_SUMMARY_MAX_BYTES,
  RUNTIME_OBSERVATION_KINDS,
  SourceSinkLeadSchema,
} from './whitebox.js';
import { type OracleBinding, OracleBindingSchema } from '../validation/oracle.js';

const COMMIT = 'a'.repeat(40);
const LEAD_ID = '0190f3a0-7c1d-7e2f-8a3b-4c5d6e7f8091';
const DECLARED_AT = '2026-01-01T00:00:00.000Z';

const LOCATION: CodeLocation = {
  repoRef: 'orders-service',
  path: 'src/routes/orders.ts',
  startLine: 42,
  endLine: 48,
  commitSha: COMMIT,
  symbol: 'getOrder',
};

const LEAD = {
  id: LEAD_ID,
  cweId: 'CWE-89',
  owaspRefs: ['A03:2021'],
  wstgRefs: ['WSTG-INPV-05'],
  source: { ...LOCATION, startLine: 10, endLine: undefined, symbol: 'req.query' },
  sink: LOCATION,
  pathSummary: 'The order id query parameter reaches the SQL builder without parameter binding.',
  confidence: 0.7,
  reachabilityHypothesis: { entrypoint: 'GET /orders/:id', roleHints: ['customer'] },
};

/** Returns a copy of `value` with `patch` applied, for building invalid vectors without `any`. */
function withPatch<T extends object>(value: T, patch: Partial<Record<keyof T, unknown>>): unknown {
  return { ...value, ...patch };
}

describe('CodeLocationSchema', () => {
  it('accepts a pinned repo-relative location', () => {
    expect(CodeLocationSchema.parse(LOCATION)).toEqual(LOCATION);
  });

  it('rejects an absolute path and a path containing `..`', () => {
    for (const path of ['/etc/passwd', '../secrets.ts', 'src/../../x.ts', '..']) {
      expect(CodeLocationSchema.safeParse({ ...LOCATION, path }).success, path).toBe(false);
    }
  });

  it('rejects a Windows drive path and backslash separators', () => {
    for (const path of ['C:/repo/x.ts', 'src\\routes\\orders.ts']) {
      expect(CodeLocationSchema.safeParse({ ...LOCATION, path }).success, path).toBe(false);
    }
  });

  it('rejects an empty or null repoRef and a missing commitSha (provenance must be pinnable)', () => {
    expect(CodeLocationSchema.safeParse({ ...LOCATION, repoRef: '' }).success).toBe(false);
    expect(CodeLocationSchema.safeParse({ ...LOCATION, repoRef: null }).success).toBe(false);
    const withoutSha: Partial<CodeLocation> = { ...LOCATION };
    delete withoutSha.commitSha;
    expect(CodeLocationSchema.safeParse(withoutSha).success).toBe(false);
  });

  it('rejects a commitSha that is not a full lowercase git commit id', () => {
    for (const commitSha of ['abc123', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) {
      expect(CodeLocationSchema.safeParse({ ...LOCATION, commitSha }).success, commitSha).toBe(
        false,
      );
    }
  });

  it('rejects a start line after the end line, and non-positive lines', () => {
    expect(CodeLocationSchema.safeParse({ ...LOCATION, startLine: 50, endLine: 49 }).success).toBe(
      false,
    );
    expect(CodeLocationSchema.safeParse({ ...LOCATION, startLine: 0 }).success).toBe(false);
    expect(CodeLocationSchema.safeParse({ ...LOCATION, startLine: 1.5 }).success).toBe(false);
  });

  it('accepts a single-line location with no endLine', () => {
    const single: CodeLocation = { ...LOCATION };
    delete single.endLine;
    expect(CodeLocationSchema.safeParse(single).success).toBe(true);
  });

  it('NFC-normalises the path and symbol before storing them', () => {
    const decomposed = 'cafe\u0301.ts';
    const parsed = CodeLocationSchema.parse({
      ...LOCATION,
      path: `src/${decomposed}`,
      symbol: 'cafe\u0301',
    });
    expect(parsed.path).toBe('src/caf\u00e9.ts');
    expect(parsed.symbol).toBe('caf\u00e9');
  });

  it('rejects control characters in the path, and unknown keys (strict)', () => {
    expect(CodeLocationSchema.safeParse({ ...LOCATION, path: 'src/a\u0000.ts' }).success).toBe(
      false,
    );
    expect(CodeLocationSchema.safeParse({ ...LOCATION, extra: 'x' }).success).toBe(false);
  });
});

describe('SourceSinkLeadSchema', () => {
  it('accepts a well-formed lead', () => {
    expect(SourceSinkLeadSchema.parse(LEAD)).toEqual(LEAD);
  });

  it('rejects an empty or malformed cweId', () => {
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, cweId: '' }).success).toBe(false);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, cweId: 'SQLi' }).success).toBe(false);
  });

  it('rejects a confidence outside [0,1] and non-finite values', () => {
    for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(SourceSinkLeadSchema.safeParse({ ...LEAD, confidence }).success, `${confidence}`).toBe(
        false,
      );
    }
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, confidence: 0 }).success).toBe(true);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, confidence: 1 }).success).toBe(true);
  });

  it('rejects an oversized pathSummary (more than 4 KiB of UTF-8)', () => {
    const tooLong = 'a'.repeat(PATH_SUMMARY_MAX_BYTES + 1);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, pathSummary: tooLong }).success).toBe(false);
    // Multi-byte text: 2049 two-byte characters are 4098 bytes, over the limit, though under 4096 characters.
    const multiByte = 'é'.repeat(PATH_SUMMARY_MAX_BYTES / 2 + 1);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, pathSummary: multiByte }).success).toBe(false);
    const atLimit = 'a'.repeat(PATH_SUMMARY_MAX_BYTES);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, pathSummary: atLimit }).success).toBe(true);
  });

  it('rejects an empty pathSummary', () => {
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, pathSummary: '' }).success).toBe(false);
  });

  it('rejects a lead whose source or sink is not a valid CodeLocation', () => {
    expect(
      SourceSinkLeadSchema.safeParse({ ...LEAD, sink: { ...LOCATION, path: '../x.ts' } }).success,
    ).toBe(false);
    expect(
      SourceSinkLeadSchema.safeParse({ ...LEAD, source: { ...LOCATION, commitSha: 'short' } })
        .success,
    ).toBe(false);
  });

  it('rejects a non-UUIDv7 lead id and unknown keys', () => {
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, id: 'lead-1' }).success).toBe(false);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, payload: 'x' }).success).toBe(false);
  });

  it('rejects a reachability hypothesis with an empty entrypoint', () => {
    expect(
      SourceSinkLeadSchema.safeParse({
        ...LEAD,
        reachabilityHypothesis: { entrypoint: '', roleHints: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects a lead with too many OWASP or WSTG references', () => {
    const refs = Array.from({ length: 17 }, (_, index) => `REF-${index}`);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, owaspRefs: refs }).success).toBe(false);
    expect(SourceSinkLeadSchema.safeParse({ ...LEAD, wstgRefs: refs }).success).toBe(false);
  });
});

describe('CodePlusRuntimeOracleSchema', () => {
  const ORACLE: CodePlusRuntimeOracle = {
    type: 'code_plus_runtime',
    params: {
      sink: LOCATION,
      runtimeObservation: { kind: 'status_diff', ref: 'evidence/status-diff-1' },
    },
  };

  it('accepts a static sink bound to a runtime observation', () => {
    expect(CodePlusRuntimeOracleSchema.parse(ORACLE)).toEqual(ORACLE);
  });

  it('accepts every runtime observation kind', () => {
    for (const kind of RUNTIME_OBSERVATION_KINDS) {
      const spec = withPatch(ORACLE, {
        params: { ...ORACLE.params, runtimeObservation: { kind, ref: 'evidence/ref-1' } },
      });
      expect(CodePlusRuntimeOracleSchema.safeParse(spec).success, kind).toBe(true);
    }
  });

  it('rejects an unknown observation kind and an unknown oracle type', () => {
    const badKind = {
      ...ORACLE,
      params: { ...ORACLE.params, runtimeObservation: { kind: 'shell', ref: 'evidence/x' } },
    };
    expect(CodePlusRuntimeOracleSchema.safeParse(badKind).success).toBe(false);
    expect(CodePlusRuntimeOracleSchema.safeParse({ ...ORACLE, type: 'marker' }).success).toBe(
      false,
    );
  });

  it('rejects an observation ref that is not a bounded evidence key (no blobs, no dot segments)', () => {
    for (const ref of [
      '',
      'data:text/plain,x',
      'evidence/../secret',
      'has space',
      'x'.repeat(300),
    ]) {
      const spec = {
        ...ORACLE,
        params: { ...ORACLE.params, runtimeObservation: { kind: 'marker', ref } },
      };
      expect(CodePlusRuntimeOracleSchema.safeParse(spec).success, ref).toBe(false);
    }
  });

  it('rejects an unknown key inside params (strict)', () => {
    const spec = { ...ORACLE, params: { ...ORACLE.params, payload: 'x' } };
    expect(CodePlusRuntimeOracleSchema.safeParse(spec).success).toBe(false);
  });

  it('type-checks against the VALIDATE oracle binding union (CODESPEC-006 import)', () => {
    const binding: OracleBinding = { ...ORACLE, declaredAt: DECLARED_AT };
    expect(OracleBindingSchema.safeParse(binding).success).toBe(true);
    expectTypeOf<Extract<OracleBinding, { type: 'code_plus_runtime' }>['params']>().toEqualTypeOf<
      CodePlusRuntimeOracle['params']
    >();
  });
});

describe('CodeEvidenceSchema and the candidate submission', () => {
  const EVIDENCE = { lead: LEAD, confirmedAt: { ...LOCATION, startLine: 44, endLine: undefined } };

  it('accepts code evidence with a lead and the confirmed location', () => {
    expect(CodeEvidenceSchema.safeParse(EVIDENCE).success).toBe(true);
  });

  it('rejects code evidence with a missing lead or an invalid confirmed location', () => {
    expect(CodeEvidenceSchema.safeParse({ confirmedAt: EVIDENCE.confirmedAt }).success).toBe(false);
    expect(
      CodeEvidenceSchema.safeParse({
        lead: LEAD,
        confirmedAt: { ...EVIDENCE.confirmedAt, path: '/abs/x.ts' },
      }).success,
    ).toBe(false);
  });

  it('accepts codeEvidence on a broker candidate submission', () => {
    const body = {
      title: 'Order id injection',
      vulnClass: 'sql_injection',
      codeEvidence: EVIDENCE,
    };
    expect(brokerCandidateRequestSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a broker candidate whose codeEvidence is malformed', () => {
    const body = {
      title: 'Order id injection',
      vulnClass: 'sql_injection',
      codeEvidence: { lead: { ...LEAD, cweId: '' }, confirmedAt: EVIDENCE.confirmedAt },
    };
    expect(brokerCandidateRequestSchema.safeParse(body).success).toBe(false);
  });
});
