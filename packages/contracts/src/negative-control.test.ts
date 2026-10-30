import { describe, expect, it } from 'vitest';

import { testCaseSchema } from './entities/test-case.js';
import { INTRUSIVENESS_CLASSES, type IntrusivenessClass } from './intrusiveness.js';
import {
  assertNegativeControl,
  compatibleNegativeControlKinds,
  defaultNegativeControlFor,
  isNegativeControlError,
  NEGATIVE_CONTROL_KINDS,
  type NegativeControlSpec,
  negativeControlProblem,
  negativeControlSpecSchema,
  NegativeControlError,
  requiresNegativeControl,
} from './negative-control.js';

const control = (overrides: Partial<NegativeControlSpec> = {}): NegativeControlSpec => ({
  kind: 'known_safe_endpoint',
  description: 'Same request to the public page',
  oracleMustNotFire: true,
  params: {},
  ...overrides,
});

/** The value a function throws, or `undefined` when it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const ORACLE_TYPES = [
  'error_signature',
  'timing_baseline',
  'status_diff',
  'marker',
  'out_of_band',
  'file_read_marker',
  'header_cookie_flag',
  'access_matrix',
] as const;

describe('negativeControlSpecSchema', () => {
  it('parses a valid control, including Unicode descriptions', () => {
    expect(negativeControlSpecSchema.safeParse(control()).success).toBe(true);
    expect(
      negativeControlSpecSchema.safeParse(
        control({
          description: 'Requête bénigne — 対照 ✓',
          kind: 'alternate_role',
          params: { role: 'viewer' },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects oracleMustNotFire:false and any other literal', () => {
    expect(
      negativeControlSpecSchema.safeParse({ ...control(), oracleMustNotFire: false }).success,
    ).toBe(false);
    expect(
      negativeControlSpecSchema.safeParse({ ...control(), oracleMustNotFire: 'true' }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind, an empty description and unknown keys', () => {
    expect(negativeControlSpecSchema.safeParse({ ...control(), kind: 'payload' }).success).toBe(
      false,
    );
    expect(negativeControlSpecSchema.safeParse({ ...control(), description: '   ' }).success).toBe(
      false,
    );
    expect(
      negativeControlSpecSchema.safeParse({ ...control(), payload: "' OR 1=1 --" }).success,
    ).toBe(false);
  });

  it('allows empty params for known_safe_endpoint but requires params for benign_variant', () => {
    expect(negativeControlSpecSchema.safeParse(control({ params: {} })).success).toBe(true);
    const benign = { ...control(), kind: 'benign_variant' as const };
    expect(negativeControlSpecSchema.safeParse({ ...benign, params: {} }).success).toBe(false);
    expect(
      negativeControlSpecSchema.safeParse({ ...benign, params: { strategy: 'benign_value' } })
        .success,
    ).toBe(true);
  });
});

describe('requiresNegativeControl', () => {
  it.each<[IntrusivenessClass, boolean]>([
    ['passive', false],
    ['active_safe', true],
    ['state_changing', true],
    ['destructive', true],
  ])('is %s -> %s (fail closed for unknown classes)', (cls, expected) => {
    expect(requiresNegativeControl({ class: cls })).toBe(expected);
  });
});

describe('compatibility matrix', () => {
  it('lists the allowed kinds for every known oracle type and only valid kinds', () => {
    for (const type of ORACLE_TYPES) {
      const kinds = compatibleNegativeControlKinds(type);
      expect(kinds, type).toBeDefined();
      expect(kinds?.length, type).toBeGreaterThan(0);
      for (const kind of kinds ?? []) {
        expect(NEGATIVE_CONTROL_KINDS).toContain(kind);
      }
    }
  });

  it('pairs access_matrix with alternate_role only', () => {
    expect(compatibleNegativeControlKinds('access_matrix')).toEqual(['alternate_role']);
  });

  it('returns undefined for unknown oracle types (fail closed)', () => {
    expect(compatibleNegativeControlKinds('response.status')).toBeUndefined();
    expect(compatibleNegativeControlKinds('__proto__')).toBeUndefined();
    expect(compatibleNegativeControlKinds('constructor')).toBeUndefined();
  });

  it('checks every oracle x kind pair exhaustively against the matrix', () => {
    for (const type of ORACLE_TYPES) {
      for (const kind of NEGATIVE_CONTROL_KINDS) {
        const allowed = compatibleNegativeControlKinds(type)?.includes(kind) === true;
        const problem = negativeControlProblem({
          class: 'active_safe',
          oracle: { type },
          negativeControl: control({
            kind,
            params: kind === 'benign_variant' ? { strategy: 'benign_value' } : {},
          }),
        });
        expect(problem === null, `${type}/${kind}`).toBe(allowed);
      }
    }
  });
});

describe('negativeControlProblem and assertNegativeControl', () => {
  it('reports NEGATIVE_CONTROL_MISSING for a non-passive case without a control', () => {
    for (const cls of ['active_safe', 'state_changing'] as const) {
      expect(
        negativeControlProblem({ class: cls, oracle: { type: 'marker' }, negativeControl: null }),
      ).toBe('NEGATIVE_CONTROL_MISSING');
    }
  });

  it('accepts a passive case without a control', () => {
    expect(
      assertNegativeControl({
        class: 'passive',
        oracle: { type: 'marker' },
        negativeControl: null,
      }),
    ).toEqual({ ignoredPassiveControl: false });
  });

  it('throws NEGATIVE_CONTROL_MISSING with the stable code', () => {
    let caught: unknown;
    try {
      assertNegativeControl({
        class: 'active_safe',
        oracle: { type: 'marker' },
        negativeControl: null,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NegativeControlError);
    expect((caught as NegativeControlError).code).toBe('NEGATIVE_CONTROL_MISSING');
    expect(isNegativeControlError(caught)).toBe(true);
  });

  it('throws NEGATIVE_CONTROL_ORACLE_MISMATCH for an incompatible pairing', () => {
    const mismatch = {
      class: 'active_safe' as const,
      oracle: { type: 'access_matrix' },
      negativeControl: control({ kind: 'known_safe_endpoint' }),
    };
    const thrown = thrownBy(() => assertNegativeControl(mismatch));
    expect(thrown).toBeInstanceOf(NegativeControlError);
    expect(thrown).toMatchObject({ code: 'NEGATIVE_CONTROL_ORACLE_MISMATCH' });
  });

  it('fails closed for an unknown oracle type even with a well-formed control', () => {
    expect(
      negativeControlProblem({
        class: 'active_safe',
        oracle: { type: 'response.status' },
        negativeControl: control(),
      }),
    ).toBe('NEGATIVE_CONTROL_ORACLE_MISMATCH');
  });

  it('accepts a compatible control and reports nothing ignored for active cases', () => {
    expect(
      assertNegativeControl({
        class: 'active_safe',
        oracle: { type: 'access_matrix' },
        negativeControl: control({ kind: 'alternate_role', params: { role: 'viewer' } }),
      }),
    ).toEqual({ ignoredPassiveControl: false });
  });

  it('allows a passive case with a compatible control but flags it as ignored', () => {
    expect(
      assertNegativeControl({
        class: 'passive',
        oracle: { type: 'marker' },
        negativeControl: control(),
      }),
    ).toEqual({ ignoredPassiveControl: true });
  });

  it('still rejects a passive case whose control mismatches the oracle', () => {
    expect(() =>
      assertNegativeControl({
        class: 'passive',
        oracle: { type: 'access_matrix' },
        negativeControl: control(),
      }),
    ).toThrow(NegativeControlError);
  });

  it('applies the missing rule to every class that requires a control', () => {
    for (const cls of INTRUSIVENESS_CLASSES) {
      expect(
        negativeControlProblem({ class: cls, oracle: { type: 'marker' }, negativeControl: null }),
      ).toBe(cls === 'passive' ? null : 'NEGATIVE_CONTROL_MISSING');
    }
  });
});

describe('defaultNegativeControlFor', () => {
  it('suggests a schema-valid, compatible control for every known oracle type', () => {
    for (const type of ORACLE_TYPES) {
      const suggestion = defaultNegativeControlFor({ type });
      expect(negativeControlSpecSchema.safeParse(suggestion).success, type).toBe(true);
      expect(
        negativeControlProblem({
          class: 'active_safe',
          oracle: { type },
          negativeControl: suggestion,
        }),
        type,
      ).toBeNull();
      expect(suggestion.oracleMustNotFire).toBe(true);
    }
  });

  it('suggests a benign_variant with structural params for error_signature', () => {
    expect(defaultNegativeControlFor({ type: 'error_signature' })).toMatchObject({
      kind: 'benign_variant',
      params: { strategy: 'benign_value' },
    });
  });

  it('suggests alternate_role for access_matrix', () => {
    expect(defaultNegativeControlFor({ type: 'access_matrix' }).kind).toBe('alternate_role');
  });

  it('throws NEGATIVE_CONTROL_ORACLE_MISMATCH for an unknown oracle type', () => {
    expect(() => defaultNegativeControlFor({ type: 'response.status' })).toThrow(
      NegativeControlError,
    );
  });
});

describe('testCaseSchema negative-control refinement', () => {
  const base = {
    id: '0196f5a0-0000-7000-8000-000000000001',
    tenantId: '0196f5a0-0000-7000-8000-000000000002',
    testPlanId: '0196f5a0-0000-7000-8000-000000000003',
    title: 'Admin page',
    refs: { owasp: [], wstg: [], asvs: [] },
    cweCandidates: [],
    targets: ['https://app.example.test/admin'],
    roles: ['anonymous'],
    budget: { maxRequests: 10, maxRps: 1, maxConcurrency: 1, maxBytes: 1_000_000 },
    oracle: { type: 'marker', params: {} },
    status: 'proposed',
    statusReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('rejects a non-passive test case without a negative control', () => {
    for (const cls of ['active_safe', 'state_changing'] as const) {
      const result = testCaseSchema.safeParse({ ...base, class: cls, negativeControl: null });
      expect(result.success, cls).toBe(false);
      expect(JSON.stringify(result.error?.issues ?? [])).toContain('NEGATIVE_CONTROL_MISSING');
    }
  });

  it('accepts a passive test case without a negative control', () => {
    expect(
      testCaseSchema.safeParse({ ...base, class: 'passive', negativeControl: null }).success,
    ).toBe(true);
  });

  it('rejects a malformed control attached to a test case', () => {
    const result = testCaseSchema.safeParse({
      ...base,
      class: 'active_safe',
      negativeControl: { ...control(), oracleMustNotFire: false },
    });
    expect(result.success).toBe(false);
  });
});
