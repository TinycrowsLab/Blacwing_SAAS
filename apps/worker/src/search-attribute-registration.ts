import { metrics } from '@opentelemetry/api';

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import {
  SEARCH_ATTRIBUTES,
  type SearchAttributeName,
  type SearchAttributeType,
} from './search-attributes.js';

// Idempotent registration of the custom search attributes in one Temporal namespace (WORKFLOW-003). Used by the
// `register-search-attributes` script on deploy and by the dev bootstrap. Nothing here ever drops or retypes an
// attribute: a type mismatch fails loudly with SEARCH_ATTR_TYPE_CONFLICT before anything is written.

/**
 * Temporal's `IndexedValueType` wire values (`temporal.api.enums.v1`), spelled out here: the protobuf package is a
 * CommonJS module that Node's ESM loader cannot read by name. A unit test checks every value against the enum.
 */
const TEMPORAL_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'INDEXED_VALUE_TYPE_UNSPECIFIED',
  1: 'INDEXED_VALUE_TYPE_TEXT',
  2: 'INDEXED_VALUE_TYPE_KEYWORD',
  3: 'INDEXED_VALUE_TYPE_INT',
  4: 'INDEXED_VALUE_TYPE_DOUBLE',
  5: 'INDEXED_VALUE_TYPE_BOOL',
  6: 'INDEXED_VALUE_TYPE_DATETIME',
  7: 'INDEXED_VALUE_TYPE_KEYWORD_LIST',
};

/** The wire value each custom attribute type is registered with. */
const TEMPORAL_TYPE: Readonly<Record<SearchAttributeType, number>> = {
  Keyword: 2,
};

/** Outcome label of `search_attribute_registration_total{result}`. */
export type SearchAttributeRegistrationResult = 'created' | 'unchanged' | 'conflict' | 'failed';

/** The slice of Temporal's operator service the registration needs (a fake in tests). */
export interface SearchAttributeOperator {
  listSearchAttributes(request: {
    namespace: string;
  }): Promise<{ customAttributes?: Readonly<Record<string, number | null | undefined>> | null }>;
  addSearchAttributes(request: {
    namespace: string;
    searchAttributes: Readonly<Record<string, number>>;
  }): Promise<unknown>;
}

/** One attribute that exists with a different type than the code expects. */
interface SearchAttributeConflict {
  readonly name: string;
  readonly expected: SearchAttributeType;
  /** Temporal's name for the registered type, e.g. `INDEXED_VALUE_TYPE_INT`. */
  readonly actual: string;
}

/** What a registration must add, and what it must refuse. */
export interface SearchAttributePlan {
  readonly toCreate: Readonly<Record<string, number>>;
  readonly conflicts: readonly SearchAttributeConflict[];
}

/** Result of one registration call. */
export interface SearchAttributeRegistrationOutcome {
  readonly result: 'created' | 'unchanged';
  /** Attributes this call added. Empty when they were all registered already. */
  readonly created: readonly string[];
}

export interface RegisterSearchAttributesOptions {
  readonly operator: SearchAttributeOperator;
  readonly namespace: string;
  /** Records the outcome of the call. Default: `search_attribute_registration_total{result}`. */
  readonly recordResult?: (result: SearchAttributeRegistrationResult) => void;
}

const log = createLogger('worker').child({ component: 'search-attributes' });
const registrationCounter = metrics
  .getMeter('@blackwing/worker')
  .createCounter('search_attribute_registration_total', {
    description: 'Search attribute registrations by result (created, unchanged, conflict, failed)',
  });

function recordRegistration(result: SearchAttributeRegistrationResult): void {
  registrationCounter.add(1, { result });
}

/** Temporal's name for an `IndexedValueType` wire value, or the number when it is not a known value. */
function typeLabel(value: number): string {
  return TEMPORAL_TYPE_NAMES[value] ?? String(value);
}

/**
 * Compares the registered custom attributes with `SEARCH_ATTRIBUTES`. An attribute that is missing is planned
 * for creation; one that exists with another type (or with the unspecified type) is a conflict. Attributes
 * this code does not know about are left alone.
 */
export function planSearchAttributeRegistration(
  existing: Readonly<Record<string, number | null | undefined>>,
): SearchAttributePlan {
  const toCreate: Record<string, number> = {};
  const conflicts: SearchAttributeConflict[] = [];
  for (const name of Object.keys(SEARCH_ATTRIBUTES) as SearchAttributeName[]) {
    const type = SEARCH_ATTRIBUTES[name];
    const wanted = TEMPORAL_TYPE[type];
    const actual = existing[name];
    if (actual === undefined || actual === null) {
      toCreate[name] = wanted;
    } else if (actual !== wanted) {
      conflicts.push({ name, expected: type, actual: typeLabel(actual) });
    }
  }
  return { toCreate, conflicts };
}

function assertNoConflicts(conflicts: readonly SearchAttributeConflict[]): void {
  if (conflicts.length === 0) return;
  const summary = conflicts
    .map((conflict) => `${conflict.name} is ${conflict.actual}, expected ${conflict.expected}`)
    .join('; ');
  throw new AppError('SEARCH_ATTR_TYPE_CONFLICT', `Search attribute type conflict: ${summary}`);
}

async function listCustom(
  operator: SearchAttributeOperator,
  namespace: string,
): Promise<Readonly<Record<string, number | null | undefined>>> {
  const response = await operator.listSearchAttributes({ namespace });
  return response.customAttributes ?? {};
}

async function reconcile(
  operator: SearchAttributeOperator,
  namespace: string,
): Promise<SearchAttributeRegistrationOutcome> {
  const first = planSearchAttributeRegistration(await listCustom(operator, namespace));
  assertNoConflicts(first.conflicts);
  const names = Object.keys(first.toCreate);
  if (names.length === 0) return { result: 'unchanged', created: [] };

  try {
    await operator.addSearchAttributes({ namespace, searchAttributes: first.toCreate });
  } catch (error) {
    // Another pod may have registered the same attributes since our listing (multi-pod deploy). Re-read: if
    // everything is now present with the right type, the race was harmless. Otherwise the add failure is real.
    const again = planSearchAttributeRegistration(await listCustom(operator, namespace));
    assertNoConflicts(again.conflicts);
    if (Object.keys(again.toCreate).length > 0) throw error;
    return { result: 'unchanged', created: [] };
  }
  return { result: 'created', created: names };
}

/**
 * Registers `SEARCH_ATTRIBUTES` in `namespace`. Idempotent: a second call (or a concurrent one from another pod)
 * changes nothing and returns `unchanged`. A type conflict throws `SEARCH_ATTR_TYPE_CONFLICT` and writes nothing.
 * Every call records exactly one `search_attribute_registration_total` sample.
 */
export async function registerSearchAttributes(
  options: RegisterSearchAttributesOptions,
): Promise<SearchAttributeRegistrationOutcome> {
  const { operator, namespace } = options;
  const record = options.recordResult ?? recordRegistration;
  try {
    const outcome = await reconcile(operator, namespace);
    record(outcome.result);
    log.info(
      { namespace, result: outcome.result, created: outcome.created },
      'search attributes registered',
    );
    return outcome;
  } catch (error) {
    const result =
      error instanceof AppError && error.code === 'SEARCH_ATTR_TYPE_CONFLICT'
        ? 'conflict'
        : 'failed';
    record(result);
    log.error({ namespace, result, err: error }, 'search attribute registration failed');
    throw error;
  }
}
