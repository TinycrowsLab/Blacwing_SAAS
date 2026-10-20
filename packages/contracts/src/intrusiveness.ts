import { z } from 'zod';

/**
 * Intrusiveness-class taxonomy (SCOPE-003, CONTEXT_PACK §3.5 / F4) and the validation rules that keep
 * every scope request, standing authorisation (SA) and test case within bounds.
 *
 * This module is the single source of truth for the classes and their order. SCOPE (request
 * ceiling), AUTHZ (`max_intrusiveness`), PLAN (`test_cases.class`), POLICY (baseline) and EGRESS
 * (enforcement) all import these helpers; never re-declare the order anywhere else.
 *
 * `destructive` is modelled only so it can be named and hard-blocked (§8.3): it is never selectable
 * and can never be a ceiling. Everything here is pure and deterministic (§8.11): runtime enforcement
 * by the baseline policy and the egress gateway is defence in depth on top of it.
 */

/** Every intrusiveness class, from least to most intrusive. Canonical lower-case forms only. */
export const INTRUSIVENESS_CLASSES = [
  'passive',
  'active_safe',
  'state_changing',
  'destructive',
] as const;

/** One intrusiveness class (§3.5). */
export type IntrusivenessClass = (typeof INTRUSIVENESS_CLASSES)[number];

/** Stable machine codes the helpers below fail with; each is registered in `@blackwing/errors`. */
export const INTRUSIVENESS_ERROR_CODES = [
  'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING',
  'SCOPE_DESTRUCTIVE_FORBIDDEN',
  'SCOPE_INVALID_CLASS',
] as const;
export type IntrusivenessErrorCode = (typeof INTRUSIVENESS_ERROR_CODES)[number];

/**
 * Zod schema for an intrusiveness class from external input (HTTP, queue, file, tool output).
 * Strict and case-sensitive: `'Passive'`, `' passive'` or `'DESTRUCTIVE'` are rejected with the
 * message `SCOPE_INVALID_CLASS`.
 */
export const intrusivenessClassSchema = z.enum(INTRUSIVENESS_CLASSES, {
  error: () => 'SCOPE_INVALID_CLASS',
});

/**
 * Total order over the classes. `satisfies Record<IntrusivenessClass, …>` makes adding a class a
 * compile error until it is ranked here (and in every other exhaustive map below).
 */
export const INTRUSIVENESS_ORDER = Object.freeze({
  passive: 0,
  active_safe: 1,
  state_changing: 2,
  destructive: 3,
} as const satisfies Record<IntrusivenessClass, number>);

const SELECTABLE = Object.freeze({
  passive: true,
  active_safe: true,
  state_changing: true,
  // Hard-blocked by the platform baseline policy (§8.3): never offered by the UI or the API.
  destructive: false,
} as const satisfies Record<IntrusivenessClass, boolean>);

const REQUIRES_REVERSAL_JOURNAL = Object.freeze({
  passive: false,
  active_safe: false,
  // §3.5/§8.3: a reversal-journal entry must be written before a state-changing action executes.
  state_changing: true,
  // Never allowed at all, so there is nothing to journal.
  destructive: false,
} as const satisfies Record<IntrusivenessClass, boolean>);

/** UI/help text for one class, phrased at engineering altitude (no exploit content). */
export interface IntrusivenessDescriptor {
  /** Short human label. */
  readonly label: string;
  /** What the class means. */
  readonly meaning: string;
  /** Representative kinds of activity, described generically. */
  readonly examples: readonly string[];
  /** Status in v1 (§3.5). */
  readonly v1: string;
}

/** Descriptor per class, for UI and help text. */
export const INTRUSIVENESS_DESCRIPTORS = Object.freeze({
  passive: {
    label: 'Passive',
    meaning: 'No crafted traffic to the target; only observation and third-party sources.',
    examples: [
      'Open-source intelligence and public records',
      'Third-party data sources such as certificate transparency',
      'Observing normal responses to ordinary requests',
    ],
    v1: 'Allowed.',
  },
  active_safe: {
    label: 'Active (safe)',
    meaning: 'Crafted requests not expected to change state on the target.',
    examples: [
      'Probing for exposed services and endpoints',
      'Injection detection with benign markers',
      'Authentication and authorisation checks using read-only requests',
    ],
    v1: 'Allowed.',
  },
  state_changing: {
    label: 'State-changing',
    meaning:
      'Creates or modifies data in a reversible way; a reversal-journal entry is written before execution.',
    examples: [
      'Creating a clearly labelled test record and removing it afterwards',
      'Changing a setting on a test-owned account and restoring it',
    ],
    v1: 'Allowed only when the standing authorisation and Gate 1 explicitly include it.',
  },
  destructive: {
    label: 'Destructive',
    meaning: 'Irreversible or availability-impacting activity.',
    examples: ['Denial of service', "Deleting other users' data", 'Mass account lockout'],
    v1: 'Never allowed: hard-blocked by the platform baseline policy.',
  },
} as const satisfies Record<IntrusivenessClass, IntrusivenessDescriptor>);

/** The classes the UI and API may offer, in order. Never contains `destructive`. */
export const SELECTABLE_INTRUSIVENESS_CLASSES: readonly IntrusivenessClass[] = Object.freeze(
  INTRUSIVENESS_CLASSES.filter((c) => SELECTABLE[c]),
);

/** Error thrown by the intrusiveness validators. `code` is a stable, registered error code. */
export class IntrusivenessError extends Error {
  readonly code: IntrusivenessErrorCode;

  constructor(code: IntrusivenessErrorCode, message: string) {
    super(message);
    this.name = 'IntrusivenessError';
    this.code = code;
  }
}

/** True when `value` is an `IntrusivenessError` (also across package copies). */
export function isIntrusivenessError(value: unknown): value is IntrusivenessError {
  return (
    value instanceof Error &&
    value.name === 'IntrusivenessError' &&
    (INTRUSIVENESS_ERROR_CODES as readonly unknown[]).includes((value as { code?: unknown }).code)
  );
}

/** True when `value` is a canonical intrusiveness class. */
export function isIntrusivenessClass(value: unknown): value is IntrusivenessClass {
  return intrusivenessClassSchema.safeParse(value).success;
}

/**
 * Parses an intrusiveness class from untrusted input.
 * @throws {IntrusivenessError} `SCOPE_INVALID_CLASS` for anything but a canonical class string.
 */
export function parseIntrusivenessClass(value: unknown): IntrusivenessClass {
  const parsed = intrusivenessClassSchema.safeParse(value);
  if (!parsed.success) {
    // The offending value is deliberately not echoed: it is untrusted input.
    throw new IntrusivenessError('SCOPE_INVALID_CLASS', 'Unknown intrusiveness class');
  }
  return parsed.data;
}

/** Rank of a class in the total order (0 = least intrusive). */
export function intrusivenessRank(c: IntrusivenessClass): number {
  return INTRUSIVENESS_ORDER[parseIntrusivenessClass(c)];
}

/** Negative, zero or positive as `a` is less, equally or more intrusive than `b`. */
export function compareIntrusiveness(a: IntrusivenessClass, b: IntrusivenessClass): number {
  return intrusivenessRank(a) - intrusivenessRank(b);
}

/** Whether a class may be offered or chosen in the UI/API. `false` only for `destructive`. */
export function isSelectable(c: IntrusivenessClass): boolean {
  return SELECTABLE[parseIntrusivenessClass(c)];
}

/** Whether actions of this class need a prior reversal-journal entry. `true` iff `state_changing`. */
export function requiresReversalJournal(c: IntrusivenessClass): boolean {
  return REQUIRES_REVERSAL_JOURNAL[parseIntrusivenessClass(c)];
}

/**
 * Asserts that `requested` does not exceed `ceiling`. Used for a request ceiling against the SA's
 * `max_intrusiveness` (SCOPE-005) and a test case against the approved run envelope (PLAN).
 * Fails closed: values that are not canonical classes (possible from untyped callers) are rejected.
 *
 * @throws {IntrusivenessError} `SCOPE_INVALID_CLASS` if either argument is not a canonical class;
 *   `SCOPE_DESTRUCTIVE_FORBIDDEN` if `ceiling` is `destructive`;
 *   `SCOPE_INTRUSIVENESS_EXCEEDS_CEILING` if `requested` ranks above `ceiling`.
 */
export function assertWithinCeiling(
  requested: IntrusivenessClass,
  ceiling: IntrusivenessClass,
): void {
  const req = parseIntrusivenessClass(requested);
  const ceil = parseIntrusivenessClass(ceiling);
  if (!SELECTABLE[ceil]) {
    throw new IntrusivenessError(
      'SCOPE_DESTRUCTIVE_FORBIDDEN',
      'The destructive class can never be an intrusiveness ceiling',
    );
  }
  if (INTRUSIVENESS_ORDER[req] > INTRUSIVENESS_ORDER[ceil]) {
    throw new IntrusivenessError(
      'SCOPE_INTRUSIVENESS_EXCEEDS_CEILING',
      `Requested intrusiveness '${req}' exceeds the ceiling '${ceil}'`,
    );
  }
}

/** Non-throwing form of {@link assertWithinCeiling}. */
export function isWithinCeiling(
  requested: IntrusivenessClass,
  ceiling: IntrusivenessClass,
): boolean {
  try {
    assertWithinCeiling(requested, ceiling);
    return true;
  } catch (error) {
    if (isIntrusivenessError(error)) return false;
    throw error;
  }
}
