import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  evidenceRefSchema,
  nfcTextSchema,
  ORACLE_BINDING_TYPES,
  type OracleBinding,
  OracleBindingSchema,
  type OracleBindingType,
  OracleObservationSchema,
} from './oracle.js';

const DECLARED_AT = '2026-01-01T00:00:00.000Z';
const CODE_LOCATION = {
  repoRef: 'orders-service',
  path: 'src/routes/orders.ts',
  startLine: 42,
  commitSha: 'a'.repeat(40),
};

/** One valid binding per declared type, so the union is exercised variant by variant. */
const VALID_BINDINGS: Record<OracleBindingType, unknown> = {
  marker: { type: 'marker', declaredAt: DECLARED_AT, params: { token: 'probe-marker-1' } },
  status_diff: {
    type: 'status_diff',
    declaredAt: DECLARED_AT,
    params: { expectedStatus: 403, baselineStatus: 200 },
  },
  timing_baseline: {
    type: 'timing_baseline',
    declaredAt: DECLARED_AT,
    params: { baselineMs: 120, minDeltaMs: 2000 },
  },
  oob: { type: 'oob', declaredAt: DECLARED_AT, params: { channel: 'dns', windowMs: 30_000 } },
  access_matrix: {
    type: 'access_matrix',
    declaredAt: DECLARED_AT,
    params: {
      functionId: 'view_admin_panel',
      actingRole: 'customer',
      comparisonRoles: ['admin'],
      expected: 'deny',
    },
  },
  error_signature: {
    type: 'error_signature',
    declaredAt: DECLARED_AT,
    params: { signature: 'SQLSTATE class 42' },
  },
  file_read: {
    type: 'file_read',
    declaredAt: DECLARED_AT,
    params: { marker: 'blackwing-sentinel-01' },
  },
  header_cookie: {
    type: 'header_cookie',
    declaredAt: DECLARED_AT,
    params: { target: 'header', name: 'Strict-Transport-Security', expectation: 'absent' },
  },
  code_plus_runtime: {
    type: 'code_plus_runtime',
    declaredAt: DECLARED_AT,
    params: {
      sink: CODE_LOCATION,
      runtimeObservation: { kind: 'status_diff', ref: 'evidence/status-diff-1' },
    },
  },
};

describe('OracleBindingSchema: deterministic evaluator params', () => {
  const bind = (type: string, params: unknown) =>
    OracleBindingSchema.safeParse({ type, declaredAt: DECLARED_AT, params });

  it('defaults a marker to a body location and accepts header and dom', () => {
    const parsed = bind('marker', { token: 'probe-1' });
    expect(parsed.success && parsed.data.type === 'marker' && parsed.data.params.location).toBe(
      'body',
    );
    expect(bind('marker', { token: 'probe-1', location: 'header' }).success).toBe(true);
    expect(bind('marker', { token: 'probe-1', location: 'query' }).success).toBe(false);
  });

  it('refuses a status differential whose expected and baseline statuses are equal', () => {
    expect(bind('status_diff', { expectedStatus: 200, baselineStatus: 200 }).success).toBe(false);
  });

  it('defaults an error signature to a body scope and accepts a header scope', () => {
    const parsed = bind('error_signature', { signature: 'SQLSTATE' });
    expect(
      parsed.success && parsed.data.type === 'error_signature' && parsed.data.params.scope,
    ).toBe('body');
    expect(bind('error_signature', { signature: 'PHP', scope: 'header' }).success).toBe(true);
    expect(bind('error_signature', { signature: 'PHP', scope: 'url' }).success).toBe(false);
  });

  it('accepts a cookie attribute check and a header disallowed value', () => {
    expect(
      bind('header_cookie', {
        target: 'cookie',
        name: 'session',
        expectation: 'present',
        attribute: 'HttpOnly',
      }).success,
    ).toBe(true);
    expect(
      bind('header_cookie', {
        target: 'header',
        name: 'Access-Control-Allow-Origin',
        expectation: 'present',
        disallowedValue: '*',
      }).success,
    ).toBe(true);
  });

  it('refuses a cookie check without an attribute, an attribute on a header, and a value on a cookie', () => {
    expect(
      bind('header_cookie', { target: 'cookie', name: 'session', expectation: 'present' }).success,
    ).toBe(false);
    expect(
      bind('header_cookie', {
        target: 'header',
        name: 'Server',
        expectation: 'absent',
        attribute: 'Secure',
      }).success,
    ).toBe(false);
    expect(
      bind('header_cookie', {
        target: 'cookie',
        name: 'session',
        expectation: 'present',
        attribute: 'Secure',
        disallowedValue: '*',
      }).success,
    ).toBe(false);
    expect(
      bind('header_cookie', {
        target: 'header',
        name: 'Server',
        expectation: 'absent',
        disallowedValue: 'nginx',
      }).success,
    ).toBe(false);
  });
});

describe('OracleBindingSchema', () => {
  it.each(ORACLE_BINDING_TYPES.map((type) => [type]))('parses one valid example of %s', (type) => {
    const binding = VALID_BINDINGS[type];
    expect(OracleBindingSchema.safeParse(binding).success).toBe(true);
  });

  it('rejects an unknown oracle type', () => {
    const result = OracleBindingSchema.safeParse({
      type: 'shell_exec',
      declaredAt: DECLARED_AT,
      params: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a binding without a declaration time', () => {
    const rest: Record<string, unknown> = { ...(VALID_BINDINGS.marker as Record<string, unknown>) };
    delete rest.declaredAt;
    expect(OracleBindingSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects params that do not match the declared type', () => {
    const result = OracleBindingSchema.safeParse({
      type: 'status_diff',
      declaredAt: DECLARED_AT,
      params: { expectedStatus: 999, baselineStatus: 200 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects params carrying extra keys, such as a request body or a command', () => {
    const result = OracleBindingSchema.safeParse({
      type: 'marker',
      declaredAt: DECLARED_AT,
      params: { token: 'probe-marker-1', command: 'curl http://example.test' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a binding with extra top-level keys', () => {
    const result = OracleBindingSchema.safeParse({
      ...(VALID_BINDINGS.oob as Record<string, unknown>),
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts smtp as an oob channel and rejects an unknown one', () => {
    const base = { type: 'oob', declaredAt: DECLARED_AT };
    expect(
      OracleBindingSchema.safeParse({ ...base, params: { channel: 'smtp', windowMs: 1000 } })
        .success,
    ).toBe(true);
    expect(
      OracleBindingSchema.safeParse({ ...base, params: { channel: 'ftp', windowMs: 1000 } })
        .success,
    ).toBe(false);
  });

  it('accepts only a benign sentinel id as a file_read marker (path, traversal or value refused)', () => {
    const base = { type: 'file_read', declaredAt: DECLARED_AT };
    for (const marker of ['blackwing-sentinel-01', 'bw_marker-7']) {
      expect(OracleBindingSchema.safeParse({ ...base, params: { marker } }).success).toBe(true);
    }
    for (const marker of ['../../etc/passwd', '/etc/shadow', 'root:x:0:0', '.env', 'ab', '']) {
      expect(OracleBindingSchema.safeParse({ ...base, params: { marker } }).success).toBe(false);
    }
  });

  it('rejects an out-of-range oob window', () => {
    const result = OracleBindingSchema.safeParse({
      type: 'oob',
      declaredAt: DECLARED_AT,
      params: { channel: 'dns', windowMs: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('stays in sync with the type list (compile-time check)', () => {
    expectTypeOf<OracleBinding['type']>().toEqualTypeOf<OracleBindingType>();
    expectTypeOf<OracleBindingType>().toEqualTypeOf<(typeof ORACLE_BINDING_TYPES)[number]>();
  });

  it('rejects a code_plus_runtime sink path that is absolute or walks up', () => {
    for (const path of ['/etc/passwd', '../secrets.ts', 'src/../../x.ts']) {
      const result = OracleBindingSchema.safeParse({
        type: 'code_plus_runtime',
        declaredAt: DECLARED_AT,
        params: {
          sink: { ...CODE_LOCATION, path },
          runtimeObservation: { kind: 'marker', ref: 'evidence/marker-1' },
        },
      });
      expect(result.success, path).toBe(false);
    }
  });

  it('NFC-normalises text params', () => {
    const decomposed = 'café';
    const parsed = OracleBindingSchema.parse({
      type: 'marker',
      declaredAt: DECLARED_AT,
      params: { token: decomposed },
    });
    expect(parsed.params).toEqual({ token: 'café', location: 'body' });
  });

  it('rejects text params with control characters or that are empty', () => {
    for (const token of ['bad\u0000token', 'line\nbreak', '']) {
      const result = OracleBindingSchema.safeParse({
        type: 'marker',
        declaredAt: DECLARED_AT,
        params: { token },
      });
      expect(result.success, JSON.stringify(token)).toBe(false);
    }
  });
});

describe('nfcTextSchema', () => {
  it('rejects text that is over the limit after normalisation', () => {
    expect(nfcTextSchema(3).safeParse('abcd').success).toBe(false);
    expect(nfcTextSchema(3).safeParse('abc').success).toBe(true);
  });
});

describe('evidenceRefSchema', () => {
  it.each([
    ['a data URI', 'data:text/plain;base64,QUJD'],
    ['a path with a dot segment', 'evidence/../secrets'],
    ['a leading slash', '/evidence/1'],
    ['an empty string', ''],
    ['an over-long reference', 'a'.repeat(257)],
    ['a whitespace-bearing blob', 'GET / HTTP/1.1\r\nHost: x'],
  ])('rejects %s', (_label, value) => {
    expect(evidenceRefSchema.safeParse(value).success).toBe(false);
  });

  it('accepts an object-key style reference', () => {
    expect(evidenceRefSchema.safeParse('runs/0190/evidence-1.har').success).toBe(true);
  });
});

describe('OracleObservationSchema', () => {
  it('parses an observation for each type and rejects an unknown one', () => {
    for (const type of ORACLE_BINDING_TYPES) {
      expect(
        OracleObservationSchema.safeParse({ type, fired: false, evidenceRefs: [] }).success,
        type,
      ).toBe(true);
    }
    expect(
      OracleObservationSchema.safeParse({ type: 'shell_exec', fired: true, evidenceRefs: [] })
        .success,
    ).toBe(false);
  });
});

describe('access_matrix oracle params (AUTHLOGIC-002)', () => {
  const accessBinding = (params: Record<string, unknown>) =>
    OracleBindingSchema.safeParse({ type: 'access_matrix', declaredAt: DECLARED_AT, params });

  const base = {
    functionId: 'view_order',
    actingRole: 'customer',
    comparisonRoles: ['admin'],
    expected: 'deny',
  };

  it('accepts a function-level and an object-level cell', () => {
    expect(accessBinding(base).success).toBe(true);
    expect(accessBinding({ ...base, objectId: 'order_1001' }).success).toBe(true);
  });

  it('rejects an acting role that is its own comparison role', () => {
    expect(accessBinding({ ...base, comparisonRoles: ['customer', 'admin'] }).success).toBe(false);
  });

  it('rejects an empty, repeated or oversized comparison-role list', () => {
    expect(accessBinding({ ...base, comparisonRoles: [] }).success).toBe(false);
    expect(accessBinding({ ...base, comparisonRoles: ['admin', 'admin'] }).success).toBe(false);
    const tooMany = Array.from({ length: 9 }, (_, i) => `role_${i}`);
    expect(accessBinding({ ...base, comparisonRoles: tooMany }).success).toBe(false);
  });

  it('rejects an expectation other than allow or deny', () => {
    expect(accessBinding({ ...base, expected: 'ambiguous' }).success).toBe(false);
  });

  it('rejects a path-like or upper-case function id', () => {
    expect(accessBinding({ ...base, functionId: '../admin' }).success).toBe(false);
    expect(accessBinding({ ...base, functionId: 'ViewOrder' }).success).toBe(false);
  });

  it('rejects a credential or payload field, so no secret can ride in the oracle', () => {
    expect(accessBinding({ ...base, password: 'hunter2' }).success).toBe(false);
    expect(accessBinding({ ...base, cookie: 'sid=1' }).success).toBe(false);
  });
});
