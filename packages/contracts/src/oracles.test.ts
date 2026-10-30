import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ORACLE_CATALOGUE_VERSION,
  ORACLE_REGISTRY,
  ORACLE_SPEC_ERROR_CODES,
  ORACLE_SPEC_MAX_BYTES,
  ORACLE_SPEC_TYPES,
  OracleSpecError,
  type OracleSpec,
  OracleSpecSchema,
  type OracleSpecType,
  isOracleSpec,
  parseOracleSpec,
} from './oracles.js';

const MARKER: OracleSpec = {
  type: 'marker',
  description: 'Benign token reflected in the response body',
  readOnly: true,
  intrusiveness: 'active_safe',
  params: { markerSource: 'generated', echoLocation: 'body', mustReflect: true },
};

const STATUS_DIFF: OracleSpec = {
  type: 'status_diff',
  description: 'Response differs from the declared baseline',
  readOnly: true,
  intrusiveness: 'passive',
  params: {
    compareTo: 'baseline',
    fields: ['status', 'length'],
    expectation: 'differs',
  },
};

const ERROR_SIGNATURE: OracleSpec = {
  type: 'error_signature',
  description: 'Response matches a catalogued error signature',
  readOnly: true,
  intrusiveness: 'passive',
  params: { signatureId: 'sql-syntax-error', matchIn: 'body', caseSensitive: false },
};

const HEADER_COOKIE_FLAG: OracleSpec = {
  type: 'header_cookie_flag',
  description: 'Session cookie is missing the Secure attribute',
  readOnly: true,
  intrusiveness: 'passive',
  params: { subject: 'cookie', name: 'session', attribute: 'Secure', expectation: 'present' },
};

const VALID: Record<OracleSpecType, OracleSpec> = {
  marker: MARKER,
  status_diff: STATUS_DIFF,
  error_signature: ERROR_SIGNATURE,
  header_cookie_flag: HEADER_COOKIE_FLAG,
};

/** Clones a valid spec as a plain JSON value, so tests can mutate one field at a time. */
function clone(type: OracleSpecType): Record<string, unknown> {
  return structuredClone(VALID[type]);
}

/** The stable error code `parseOracleSpec` fails with, or `undefined` when the spec parses. */
function failureCode(input: unknown): string | undefined {
  try {
    parseOracleSpec(input);
    return undefined;
  } catch (error) {
    return error instanceof OracleSpecError ? error.code : 'UNEXPECTED';
  }
}

/** A copy of `value` without `key`. */
function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
}

function withParams(type: OracleSpecType, params: Record<string, unknown>): unknown {
  return { ...clone(type), params };
}

describe('OracleSpecSchema', () => {
  it.each(ORACLE_SPEC_TYPES.map((type) => [type]))('parses a valid %s spec', (type) => {
    expect(OracleSpecSchema.safeParse(VALID[type]).success).toBe(true);
    expect(parseOracleSpec(VALID[type])).toEqual(VALID[type]);
  });

  it('rejects an unknown type with ORACLE_TYPE_UNKNOWN', () => {
    expect(failureCode({ ...clone('marker'), type: 'shell_exec' })).toBe('ORACLE_TYPE_UNKNOWN');
    expect(OracleSpecSchema.safeParse({ ...clone('marker'), type: 'shell_exec' }).success).toBe(
      false,
    );
  });

  it('rejects the removed header_cookie type name', () => {
    expect(failureCode({ ...clone('header_cookie_flag'), type: 'header_cookie' })).toBe(
      'ORACLE_TYPE_UNKNOWN',
    );
  });

  it('fails a spec with missing params with ORACLE_SPEC_INVALID', () => {
    const rest = omit(clone('marker'), 'params');
    expect(failureCode(rest)).toBe('ORACLE_SPEC_INVALID');
  });

  it('rejects empty params', () => {
    expect(isOracleSpec(withParams('marker', {}))).toBe(false);
    expect(isOracleSpec(withParams('status_diff', {}))).toBe(false);
  });

  it('rejects a spec without a description or with an empty one', () => {
    const rest = omit(clone('marker'), 'description');
    expect(isOracleSpec(rest)).toBe(false);
    expect(isOracleSpec({ ...clone('marker'), description: '' })).toBe(false);
  });

  it('rejects extra top-level keys', () => {
    expect(isOracleSpec({ ...clone('marker'), extra: true })).toBe(false);
  });

  it('rejects a readOnly value other than true', () => {
    expect(isOracleSpec({ ...clone('marker'), readOnly: false })).toBe(false);
    expect(isOracleSpec({ ...clone('marker'), readOnly: 'true' })).toBe(false);
  });

  it('rejects a destructive or state-changing intrusiveness on a read-only spec', () => {
    expect(isOracleSpec({ ...clone('marker'), intrusiveness: 'destructive' })).toBe(false);
    expect(isOracleSpec({ ...clone('marker'), intrusiveness: 'state_changing' })).toBe(false);
    expect(isOracleSpec({ ...clone('marker'), intrusiveness: 'Passive' })).toBe(false);
  });

  it('rejects a missing intrusiveness hint', () => {
    const rest = omit(clone('marker'), 'intrusiveness');
    expect(isOracleSpec(rest)).toBe(false);
  });

  it('rejects params carrying extra keys, such as a request body or a command', () => {
    expect(
      isOracleSpec(
        withParams('marker', {
          markerSource: 'generated',
          echoLocation: 'body',
          mustReflect: true,
          body: '<script>alert(1)</script>',
        }),
      ),
    ).toBe(false);
    expect(
      isOracleSpec(
        withParams('error_signature', {
          signatureId: 'sql-syntax-error',
          matchIn: 'body',
          caseSensitive: false,
          command: 'curl http://example.test',
        }),
      ),
    ).toBe(false);
  });

  it('rejects an out-of-catalogue enum value', () => {
    expect(
      isOracleSpec(
        withParams('marker', { markerSource: 'payload', echoLocation: 'body', mustReflect: true }),
      ),
    ).toBe(false);
    expect(
      isOracleSpec(
        withParams('status_diff', {
          compareTo: 'baseline',
          fields: ['body'],
          expectation: 'differs',
        }),
      ),
    ).toBe(false);
  });

  it('rejects a non-boolean mustReflect', () => {
    expect(
      isOracleSpec(
        withParams('marker', {
          markerSource: 'generated',
          echoLocation: 'body',
          mustReflect: 'yes',
        }),
      ),
    ).toBe(false);
  });

  it('rejects status_diff with no fields, too many fields, or a repeated field', () => {
    const base = { compareTo: 'baseline', expectation: 'differs' };
    expect(isOracleSpec(withParams('status_diff', { ...base, fields: [] }))).toBe(false);
    expect(
      isOracleSpec(
        withParams('status_diff', {
          ...base,
          fields: ['status', 'length', 'contentType', 'location', 'status'],
        }),
      ),
    ).toBe(false);
    expect(isOracleSpec(withParams('status_diff', { ...base, fields: ['status', 'status'] }))).toBe(
      false,
    );
  });

  it('accepts a status_diff compared with a negative control', () => {
    expect(
      isOracleSpec(
        withParams('status_diff', {
          compareTo: 'negative_control',
          fields: ['contentType'],
          expectation: 'matches',
        }),
      ),
    ).toBe(true);
  });

  it('rejects an empty or over-long signatureId', () => {
    expect(
      isOracleSpec(
        withParams('error_signature', { signatureId: '', matchIn: 'body', caseSensitive: true }),
      ),
    ).toBe(false);
    expect(
      isOracleSpec(
        withParams('error_signature', {
          signatureId: 'a'.repeat(65),
          matchIn: 'body',
          caseSensitive: true,
        }),
      ),
    ).toBe(false);
  });

  it('accepts Unicode in signatureId and normalises it to NFC', () => {
    const parsed = parseOracleSpec(
      withParams('error_signature', {
        signatureId: 'café-error',
        matchIn: 'headers',
        caseSensitive: true,
      }),
    );
    expect(parsed.params).toEqual({
      signatureId: 'café-error',
      matchIn: 'headers',
      caseSensitive: true,
    });
  });

  it('rejects a signatureId that holds a control character', () => {
    expect(
      isOracleSpec(
        withParams('error_signature', {
          signatureId: 'bad\u0000id',
          matchIn: 'body',
          caseSensitive: true,
        }),
      ),
    ).toBe(false);
  });

  it('rejects an equals expectation without a value', () => {
    expect(
      isOracleSpec(
        withParams('header_cookie_flag', {
          subject: 'header',
          name: 'X-Frame-Options',
          expectation: 'equals',
        }),
      ),
    ).toBe(false);
  });

  it('rejects a value given with a present or absent expectation', () => {
    for (const expectation of ['present', 'absent']) {
      expect(
        isOracleSpec(
          withParams('header_cookie_flag', {
            subject: 'header',
            name: 'Strict-Transport-Security',
            expectation,
            value: 'max-age=31536000',
          }),
        ),
        expectation,
      ).toBe(false);
    }
  });

  it('accepts an equals expectation with a header value', () => {
    expect(
      isOracleSpec(
        withParams('header_cookie_flag', {
          subject: 'header',
          name: 'X-Frame-Options',
          expectation: 'equals',
          value: 'DENY',
        }),
      ),
    ).toBe(true);
  });

  it('rejects a header value that carries markup or a quote', () => {
    for (const value of ['<script>', "x'y", 'a"b', 'line\nbreak']) {
      expect(
        isOracleSpec(
          withParams('header_cookie_flag', {
            subject: 'header',
            name: 'X-Frame-Options',
            expectation: 'equals',
            value,
          }),
        ),
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('rejects an unknown subject for header_cookie_flag', () => {
    expect(
      isOracleSpec(
        withParams('header_cookie_flag', { subject: 'body', name: 'x', expectation: 'present' }),
      ),
    ).toBe(false);
  });

  it('rejects a spec over the size budget', () => {
    const oversized = {
      ...clone('marker'),
      description: 'a'.repeat(ORACLE_SPEC_MAX_BYTES),
    };
    expect(failureCode(oversized)).toBe('ORACLE_SPEC_TOO_LARGE');
    expect(isOracleSpec(oversized)).toBe(false);
  });

  it('rejects a value that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = { ...clone('marker') };
    cyclic.self = cyclic;
    expect(failureCode(cyclic)).toBe('ORACLE_SPEC_TOO_LARGE');
  });

  it('rejects a type value that is not a string', () => {
    expect(failureCode({ ...clone('marker'), type: 7 })).toBe('ORACLE_TYPE_UNKNOWN');
  });

  it('rejects a non-object input with ORACLE_SPEC_INVALID', () => {
    for (const input of [null, 'marker', 42, []]) {
      expect(failureCode(input)).toBe('ORACLE_SPEC_INVALID');
    }
  });

  it('exposes a stable set of error codes', () => {
    expect([...ORACLE_SPEC_ERROR_CODES]).toEqual([
      'ORACLE_TYPE_UNKNOWN',
      'ORACLE_SPEC_INVALID',
      'ORACLE_SPEC_TOO_LARGE',
    ]);
  });

  it('keeps the type union in step with the type list (compile-time check)', () => {
    expectTypeOf<OracleSpec['type']>().toEqualTypeOf<OracleSpecType>();
    expectTypeOf<OracleSpecType>().toEqualTypeOf<(typeof ORACLE_SPEC_TYPES)[number]>();
  });
});

describe('ORACLE_REGISTRY', () => {
  it('holds exactly the four catalogue types, each with a label and standards hints', () => {
    expect(Object.keys(ORACLE_REGISTRY).sort()).toEqual([...ORACLE_SPEC_TYPES].sort());
    for (const type of ORACLE_SPEC_TYPES) {
      const entry = ORACLE_REGISTRY[type];
      expect(entry.label.length, type).toBeGreaterThan(0);
      expect(entry.standards.length, type).toBeGreaterThan(0);
    }
  });

  it('describes the marker type as reflection-class (CWE-79)', () => {
    expect(ORACLE_REGISTRY.marker.standards).toContain('CWE-79');
  });

  it('holds no standards ID that is a payload', () => {
    for (const type of ORACLE_SPEC_TYPES) {
      for (const standard of ORACLE_REGISTRY[type].standards) {
        expect(standard).toMatch(/^[A-Z]+-[A-Z0-9-]+$/);
      }
    }
  });
});

describe('catalogue invariants', () => {
  it('declares a catalogue version', () => {
    expect(ORACLE_CATALOGUE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('marks every type read-only', () => {
    for (const type of ORACLE_SPEC_TYPES) {
      expect(VALID[type].readOnly).toBe(true);
    }
  });

  it('gives each type a params field set with no payload-bearing key', () => {
    const fieldSets: Record<OracleSpecType, string[]> = {
      marker: ['echoLocation', 'markerSource', 'mustReflect'],
      status_diff: ['compareTo', 'expectation', 'fields'],
      error_signature: ['caseSensitive', 'matchIn', 'signatureId'],
      header_cookie_flag: ['attribute', 'expectation', 'name', 'subject', 'value'],
    };
    const payloadKeys = /body|payload|command|script|request|query|header_?value|raw|html|code/i;
    for (const type of ORACLE_SPEC_TYPES) {
      const shape = OracleSpecSchema.options.find((option) => option.shape.type.value === type)
        ?.shape.params;
      expect(shape, type).toBeDefined();
      const keys = Object.keys(shape?.shape ?? {}).sort();
      expect(keys, type).toEqual(fieldSets[type]);
      for (const key of keys) {
        expect(key, `${type}.${key}`).not.toMatch(payloadKeys);
      }
    }
  });
});

describe('oracle spec property', () => {
  const nfcText = fc.constantFrom('probe', 'café', 'naïve', 'sig-42', 'Secure');
  const intrusiveness = fc.constantFrom('passive' as const, 'active_safe' as const);
  const description = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,-]{0,60}$/);

  const markerArb = fc.record({
    type: fc.constant('marker' as const),
    description,
    readOnly: fc.constant(true as const),
    intrusiveness,
    params: fc.record({
      markerSource: fc.constantFrom('generated' as const, 'caller' as const),
      echoLocation: fc.constantFrom('body' as const, 'header' as const, 'both' as const),
      mustReflect: fc.boolean(),
    }),
  });

  const statusDiffArb = fc.record({
    type: fc.constant('status_diff' as const),
    description,
    readOnly: fc.constant(true as const),
    intrusiveness,
    params: fc.record({
      compareTo: fc.constantFrom('baseline' as const, 'negative_control' as const),
      fields: fc.uniqueArray(
        fc.constantFrom(
          'status' as const,
          'length' as const,
          'contentType' as const,
          'location' as const,
        ),
        { minLength: 1, maxLength: 4 },
      ),
      expectation: fc.constantFrom('differs' as const, 'matches' as const),
    }),
  });

  const errorSignatureArb = fc.record({
    type: fc.constant('error_signature' as const),
    description,
    readOnly: fc.constant(true as const),
    intrusiveness,
    params: fc.record({
      signatureId: nfcText,
      matchIn: fc.constantFrom('body' as const, 'headers' as const),
      caseSensitive: fc.boolean(),
    }),
  });

  const headerCookieArb = fc
    .oneof(
      fc.record({
        expectation: fc.constantFrom('present' as const, 'absent' as const),
        value: fc.constant(undefined),
      }),
      fc.record({
        expectation: fc.constant('equals' as const),
        value: fc.constantFrom('DENY', 'nosniff', 'max-age=31536000; includeSubDomains'),
      }),
    )
    .chain((flags) =>
      fc.record({
        type: fc.constant('header_cookie_flag' as const),
        description,
        readOnly: fc.constant(true as const),
        intrusiveness,
        params: fc.record({
          subject: fc.constantFrom('header' as const, 'cookie' as const),
          name: nfcText,
          attribute: fc.option(nfcText, { nil: undefined }),
          expectation: fc.constant(flags.expectation),
          value: fc.constant(flags.value),
        }),
      }),
    );

  it('round-trips any valid random spec through JSON unchanged', () => {
    fc.assert(
      fc.property(
        fc.oneof(markerArb, statusDiffArb, errorSignatureArb, headerCookieArb),
        (spec) => {
          const json = structuredClone(spec) as unknown;
          const parsed = parseOracleSpec(json);
          expect(parsed).toEqual(structuredClone(spec));
          expect(parseOracleSpec(structuredClone(parsed))).toEqual(parsed);
        },
      ),
    );
  });
});
