import { z } from 'zod';

import { LIMITS } from './limits.js';

import type { IntrusivenessClass } from './intrusiveness.js';

/**
 * Negative-control specification (F16, §7 `test_cases.negative_control`, REFERENCES §7). A negative
 * control is the parallel benign or known-safe case declared next to an active test case. It must NOT
 * fire the oracle. A candidate is confirmable only when the positive case fires and the negative control
 * does not, which is the primary false-positive guard.
 *
 * Pure and deterministic (§8.11). It holds structure only: no payload strings, no secrets, no exploit
 * steps. The oracle catalogue (#392) owns the per-type parameter schemas; here an oracle is identified by
 * its type key only.
 */

/** The kinds of negative control a test case can declare. */
export const NEGATIVE_CONTROL_KINDS = [
  'benign_variant',
  'known_safe_endpoint',
  'unauthenticated_baseline',
  'alternate_role',
] as const;
export type NegativeControlKind = (typeof NEGATIVE_CONTROL_KINDS)[number];

/** Stable machine codes the negative-control checks fail with; each is registered in `@blackwing/errors`. */
export const NEGATIVE_CONTROL_ERROR_CODES = [
  'NEGATIVE_CONTROL_MISSING',
  'NEGATIVE_CONTROL_ORACLE_MISMATCH',
] as const;
export type NegativeControlErrorCode = (typeof NEGATIVE_CONTROL_ERROR_CODES)[number];

/**
 * Oracle type -> the control kinds that may be bound to it, in preference order (the first is the default).
 * Oracle types come from the web/API catalogue (`packages/domain/src/testcases/webapi.ts`) plus
 * `access_matrix`. An oracle type that is not listed has no compatible control and fails closed.
 */
const CONTROL_KINDS_BY_ORACLE: ReadonlyMap<string, readonly NegativeControlKind[]> = new Map([
  ['error_signature', ['benign_variant', 'known_safe_endpoint']],
  ['timing_baseline', ['benign_variant', 'known_safe_endpoint']],
  ['status_diff', ['benign_variant', 'known_safe_endpoint', 'unauthenticated_baseline']],
  ['marker', ['benign_variant', 'known_safe_endpoint']],
  ['out_of_band', ['benign_variant', 'known_safe_endpoint']],
  ['file_read_marker', ['benign_variant', 'known_safe_endpoint']],
  ['header_cookie_flag', ['known_safe_endpoint']],
  ['access_matrix', ['alternate_role']],
]);

/** Structural parameters the default control of each kind carries. `benign_variant` must describe its variant. */
const DEFAULT_PARAMS: Readonly<Record<NegativeControlKind, Readonly<Record<string, string>>>> = {
  benign_variant: { strategy: 'benign_value' },
  known_safe_endpoint: {},
  unauthenticated_baseline: {},
  alternate_role: {},
};

/** A negative control. `oracleMustNotFire` is a literal `true`: a control that may fire is not a control. */
export const negativeControlSpecSchema = z
  .strictObject({
    kind: z.enum(NEGATIVE_CONTROL_KINDS),
    description: z.string().trim().min(1).max(LIMITS.reasonMax),
    oracleMustNotFire: z.literal(true),
    params: z.record(z.string(), z.json()),
  })
  .superRefine((control, ctx) => {
    if (control.kind === 'benign_variant' && Object.keys(control.params).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['params'],
        message: 'a benign_variant control must describe its variant in params',
      });
    }
  });
export type NegativeControlSpec = z.infer<typeof negativeControlSpecSchema>;

/** The slice of a test case the negative-control rules read. */
export interface NegativeControlSubject {
  readonly class: IntrusivenessClass;
  readonly oracle: { readonly type: string };
  readonly negativeControl: NegativeControlSpec | null;
}

/** Thrown by `assertNegativeControl`. `code` is one of `NEGATIVE_CONTROL_ERROR_CODES`. */
export class NegativeControlError extends Error {
  readonly code: NegativeControlErrorCode;

  constructor(code: NegativeControlErrorCode, message: string) {
    super(message);
    this.name = 'NegativeControlError';
    this.code = code;
  }
}

/** True when `value` is a `NegativeControlError` (also across package copies). */
export function isNegativeControlError(value: unknown): value is NegativeControlError {
  return (
    value instanceof Error &&
    value.name === 'NegativeControlError' &&
    (NEGATIVE_CONTROL_ERROR_CODES as readonly unknown[]).includes(
      (value as { code?: unknown }).code,
    )
  );
}

/** Every class except `passive` needs a negative control (fail closed: unknown future classes need one too). */
export function requiresNegativeControl(subject: Pick<NegativeControlSubject, 'class'>): boolean {
  return subject.class !== 'passive';
}

/** The control kinds an oracle type accepts, or `undefined` when the oracle type is unknown. */
export function compatibleNegativeControlKinds(
  oracleType: string,
): readonly NegativeControlKind[] | undefined {
  return CONTROL_KINDS_BY_ORACLE.get(oracleType);
}

/**
 * The first negative-control error this subject breaks, or `null` when it is valid. Pure; the schema
 * refinement and `assertNegativeControl` both use it so they cannot disagree.
 */
export function negativeControlProblem(
  subject: NegativeControlSubject,
): NegativeControlErrorCode | null {
  const control = subject.negativeControl;
  if (control === null) {
    return requiresNegativeControl(subject) ? 'NEGATIVE_CONTROL_MISSING' : null;
  }
  const accepted = compatibleNegativeControlKinds(subject.oracle.type);
  return accepted?.includes(control.kind) === true ? null : 'NEGATIVE_CONTROL_ORACLE_MISMATCH';
}

/**
 * Throws `NegativeControlError` when the subject lacks a required control or pairs one with an incompatible
 * oracle. Returns `ignoredPassiveControl: true` when a `passive` case carries a (compatible) control, which is
 * allowed but has no effect: the caller warns once.
 */
export function assertNegativeControl(subject: NegativeControlSubject): {
  readonly ignoredPassiveControl: boolean;
} {
  const problem = negativeControlProblem(subject);
  if (problem === 'NEGATIVE_CONTROL_MISSING') {
    throw new NegativeControlError(
      problem,
      `a ${subject.class} test case needs a negative control`,
    );
  }
  if (problem === 'NEGATIVE_CONTROL_ORACLE_MISMATCH') {
    throw new NegativeControlError(
      problem,
      `negative control ${subject.negativeControl?.kind ?? 'none'} does not suit oracle ${subject.oracle.type}`,
    );
  }
  return { ignoredPassiveControl: subject.class === 'passive' && subject.negativeControl !== null };
}

/**
 * Suggested control for an oracle type, for the planner and UI: the first compatible kind, with structural
 * default params. Throws `NegativeControlError` for an unknown oracle type.
 */
export function defaultNegativeControlFor(oracle: { readonly type: string }): NegativeControlSpec {
  const kind = compatibleNegativeControlKinds(oracle.type)?.[0];
  if (kind === undefined) {
    throw new NegativeControlError(
      'NEGATIVE_CONTROL_ORACLE_MISMATCH',
      `no negative control is defined for oracle ${oracle.type}`,
    );
  }
  return {
    kind,
    description: `Same ${kind.replace(/_/g, ' ')} check against ${oracle.type}: the oracle must not fire.`,
    oracleMustNotFire: true,
    params: { ...DEFAULT_PARAMS[kind] },
  };
}
