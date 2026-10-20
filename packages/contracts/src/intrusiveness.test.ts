import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { authorisableIntrusivenessSchema, intrusivenessSchema } from './entities/authorisation.js';
import {
  assertWithinCeiling,
  compareIntrusiveness,
  INTRUSIVENESS_CLASSES,
  INTRUSIVENESS_DESCRIPTORS,
  INTRUSIVENESS_ORDER,
  type IntrusivenessClass,
  intrusivenessClassSchema,
  IntrusivenessError,
  type IntrusivenessErrorCode,
  intrusivenessRank,
  isIntrusivenessClass,
  isIntrusivenessError,
  isSelectable,
  isWithinCeiling,
  parseIntrusivenessClass,
  requiresReversalJournal,
  SELECTABLE_INTRUSIVENESS_CLASSES,
} from './index.js';

/** Runs `fn` and returns the `IntrusivenessError` code it throws (fails the test otherwise). */
function codeOf(fn: () => unknown): IntrusivenessErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IntrusivenessError);
    expect(isIntrusivenessError(error)).toBe(true);
    if (isIntrusivenessError(error)) return error.code;
  }
  throw new Error('expected an IntrusivenessError');
}

/** Bypasses the static type to model an untyped (JS or unparsed) caller. */
const untyped = (value: unknown): IntrusivenessClass => value as IntrusivenessClass;

const SELECTABLE_CEILINGS = ['passive', 'active_safe', 'state_changing'] as const;

describe('intrusiveness taxonomy (SCOPE-003)', () => {
  it('defines exactly the four §3.5 classes with the specified total order', () => {
    expect(INTRUSIVENESS_CLASSES).toEqual([
      'passive',
      'active_safe',
      'state_changing',
      'destructive',
    ]);
    expect(INTRUSIVENESS_ORDER).toEqual({
      passive: 0,
      active_safe: 1,
      state_changing: 2,
      destructive: 3,
    });
    // The tuple order and the rank map agree, so there is one order.
    INTRUSIVENESS_CLASSES.forEach((c, i) => {
      expect(intrusivenessRank(c)).toBe(i);
    });
    expect(Object.isFrozen(INTRUSIVENESS_ORDER)).toBe(true);
  });

  it('orders classes totally and consistently (property)', () => {
    const cls = fc.constantFrom(...INTRUSIVENESS_CLASSES);
    fc.assert(
      fc.property(cls, cls, (a, b) => {
        expect(Math.sign(compareIntrusiveness(a, b)) + Math.sign(compareIntrusiveness(b, a))).toBe(
          0,
        );
        expect(compareIntrusiveness(a, b) === 0).toBe(a === b);
      }),
    );
  });

  it('entity schemas reuse the one definition (no second copy of the taxonomy)', () => {
    expect(intrusivenessSchema).toBe(intrusivenessClassSchema);
    expect(authorisableIntrusivenessSchema.options).toEqual([...SELECTABLE_INTRUSIVENESS_CLASSES]);
  });
});

describe('isSelectable', () => {
  it('is false for destructive and true for every other class', () => {
    expect(isSelectable('destructive')).toBe(false);
    expect(isSelectable('passive')).toBe(true);
    expect(isSelectable('active_safe')).toBe(true);
    expect(isSelectable('state_changing')).toBe(true);
    expect(SELECTABLE_INTRUSIVENESS_CLASSES).toEqual(['passive', 'active_safe', 'state_changing']);
    expect(SELECTABLE_INTRUSIVENESS_CLASSES).not.toContain('destructive');
  });

  it('rejects an unknown class instead of answering', () => {
    expect(codeOf(() => isSelectable(untyped('DESTRUCTIVE')))).toBe('SCOPE_INVALID_CLASS');
  });
});

describe('requiresReversalJournal', () => {
  it('is true for state_changing and false for every other class', () => {
    expect(requiresReversalJournal('state_changing')).toBe(true);
    for (const c of INTRUSIVENESS_CLASSES.filter((x) => x !== 'state_changing'))
      expect(requiresReversalJournal(c)).toBe(false);
  });

  it('rejects an unknown class instead of answering', () => {
    expect(codeOf(() => requiresReversalJournal(untyped('state-changing')))).toBe(
      'SCOPE_INVALID_CLASS',
    );
  });
});

describe('assertWithinCeiling', () => {
  it("throws SCOPE_INTRUSIVENESS_EXCEEDS_CEILING for ('state_changing', 'active_safe')", () => {
    expect(
      codeOf(() => {
        assertWithinCeiling('state_changing', 'active_safe');
      }),
    ).toBe('SCOPE_INTRUSIVENESS_EXCEEDS_CEILING');
  });

  it('rejects a destructive ceiling with SCOPE_DESTRUCTIVE_FORBIDDEN, whatever is requested', () => {
    for (const requested of INTRUSIVENESS_CLASSES)
      expect(
        codeOf(() => {
          assertWithinCeiling(requested, 'destructive');
        }),
      ).toBe('SCOPE_DESTRUCTIVE_FORBIDDEN');
  });

  it('never lets destructive through under any selectable ceiling', () => {
    for (const ceiling of SELECTABLE_CEILINGS)
      expect(
        codeOf(() => {
          assertWithinCeiling('destructive', ceiling);
        }),
      ).toBe('SCOPE_INTRUSIVENESS_EXCEEDS_CEILING');
  });

  it('matches the order for every (requested, ceiling) pair', () => {
    for (const requested of INTRUSIVENESS_CLASSES)
      for (const ceiling of SELECTABLE_CEILINGS) {
        const within = INTRUSIVENESS_ORDER[requested] <= INTRUSIVENESS_ORDER[ceiling];
        expect(isWithinCeiling(requested, ceiling)).toBe(within);
        let thrown: unknown = null;
        try {
          assertWithinCeiling(requested, ceiling);
        } catch (error) {
          thrown = error;
        }
        expect(thrown === null).toBe(within);
        expect(isIntrusivenessError(thrown) ? thrown.code : null).toBe(
          within ? null : 'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING',
        );
      }
  });

  it('allows a class equal to its ceiling', () => {
    for (const c of SELECTABLE_CEILINGS)
      expect(() => {
        assertWithinCeiling(c, c);
      }).not.toThrow();
  });

  it('edge: a request ceiling above the SA max_intrusiveness is rejected (SCOPE-005 use)', () => {
    const saMax: IntrusivenessClass = 'active_safe';
    const requestCeiling: IntrusivenessClass = 'state_changing';
    expect(
      codeOf(() => {
        assertWithinCeiling(requestCeiling, saMax);
      }),
    ).toBe('SCOPE_INTRUSIVENESS_EXCEEDS_CEILING');
  });

  it('edge: a test case above the approved run envelope is rejected by the same helper (PLAN use)', () => {
    const envelopeCeiling: IntrusivenessClass = 'passive';
    const testCaseClass: IntrusivenessClass = 'active_safe';
    expect(isWithinCeiling(testCaseClass, envelopeCeiling)).toBe(false);
    expect(
      codeOf(() => {
        assertWithinCeiling(testCaseClass, envelopeCeiling);
      }),
    ).toBe('SCOPE_INTRUSIVENESS_EXCEEDS_CEILING');
  });

  it('fails closed on unknown values from untyped callers (never treats them as rank-less)', () => {
    for (const bad of ['', 'Passive', 'ACTIVE_SAFE', 'unknown', undefined, null, 0, {}]) {
      expect(
        codeOf(() => {
          assertWithinCeiling(untyped(bad), 'state_changing');
        }),
      ).toBe('SCOPE_INVALID_CLASS');
      expect(
        codeOf(() => {
          assertWithinCeiling('passive', untyped(bad));
        }),
      ).toBe('SCOPE_INVALID_CLASS');
      expect(isWithinCeiling(untyped(bad), 'state_changing')).toBe(false);
    }
  });

  it('does not echo untrusted input in the invalid-class message', () => {
    expect(() => parseIntrusivenessClass('<script>')).toThrow(IntrusivenessError);
    expect(() => parseIntrusivenessClass('<script>')).not.toThrow(/script/);
  });
});

describe('class parsing from external input', () => {
  it('accepts every canonical class', () => {
    for (const c of INTRUSIVENESS_CLASSES) {
      expect(intrusivenessClassSchema.parse(c)).toBe(c);
      expect(parseIntrusivenessClass(c)).toBe(c);
      expect(isIntrusivenessClass(c)).toBe(true);
    }
  });

  it('edge: rejects an unknown class string with SCOPE_INVALID_CLASS (Zod enum)', () => {
    const result = intrusivenessClassSchema.safeParse('aggressive');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('SCOPE_INVALID_CLASS');
    expect(codeOf(() => parseIntrusivenessClass('aggressive'))).toBe('SCOPE_INVALID_CLASS');
  });

  it('edge: is case-sensitive and accepts only the lower-case canonical forms', () => {
    for (const c of INTRUSIVENESS_CLASSES)
      for (const variant of [
        c.toUpperCase(),
        `${c.charAt(0).toUpperCase()}${c.slice(1)}`,
        ` ${c}`,
        `${c} `,
      ]) {
        expect(isIntrusivenessClass(variant)).toBe(false);
        expect(codeOf(() => parseIntrusivenessClass(variant))).toBe('SCOPE_INVALID_CLASS');
      }
  });

  it('rejects arbitrary non-canonical input (property)', () => {
    fc.assert(
      fc.property(
        fc.anything().filter((v) => !(INTRUSIVENESS_CLASSES as readonly unknown[]).includes(v)),
        (v) => {
          expect(isIntrusivenessClass(v)).toBe(false);
        },
      ),
    );
  });
});

describe('descriptors', () => {
  it('describe every class with a label, meaning, examples and v1 status', () => {
    expect(Object.keys(INTRUSIVENESS_DESCRIPTORS).sort()).toEqual(
      [...INTRUSIVENESS_CLASSES].sort(),
    );
    for (const c of INTRUSIVENESS_CLASSES) {
      const d = INTRUSIVENESS_DESCRIPTORS[c];
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.meaning.length).toBeGreaterThan(0);
      expect(d.examples.length).toBeGreaterThan(0);
      expect(d.v1.length).toBeGreaterThan(0);
    }
    expect(INTRUSIVENESS_DESCRIPTORS.active_safe.meaning).toMatch(/not expected to change state/);
    expect(INTRUSIVENESS_DESCRIPTORS.destructive.v1).toMatch(/Never allowed/);
  });

  it('contain no exploit content (no payload-like strings)', () => {
    const text = JSON.stringify(INTRUSIVENESS_DESCRIPTORS);
    for (const marker of ['<script', "' OR ", '1=1', 'UNION SELECT', '../', 'rm -rf', '${'])
      expect(text).not.toContain(marker);
  });
});

describe('exhaustiveness (compile-time)', () => {
  it('the class union is derived from the one tuple', () => {
    expectTypeOf<IntrusivenessClass>().toEqualTypeOf<
      'passive' | 'active_safe' | 'state_changing' | 'destructive'
    >();
    expectTypeOf<keyof typeof INTRUSIVENESS_ORDER>().toEqualTypeOf<IntrusivenessClass>();
    expectTypeOf<keyof typeof INTRUSIVENESS_DESCRIPTORS>().toEqualTypeOf<IntrusivenessClass>();
  });

  it('a map missing a class does not satisfy Record<IntrusivenessClass, …>', () => {
    // @ts-expect-error -- `destructive` is missing: adding/omitting a class must fail to compile.
    const partial = { passive: 0, active_safe: 1, state_changing: 2 } satisfies Record<
      IntrusivenessClass,
      number
    >;
    expect(Object.keys(partial)).toHaveLength(3);
  });
});
