import { temporal } from '@temporalio/proto';
import { describe, expect, it, vi } from 'vitest';

import { isAppError } from '@blackwing/errors';

import {
  planSearchAttributeRegistration,
  registerSearchAttributes,
  type SearchAttributeOperator,
  type SearchAttributeRegistrationResult,
} from './search-attribute-registration.js';

const KEYWORD: number = temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD;
const INT: number = temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT;
const NAMESPACE = 'blackwing-test';

/**
 * In-memory stand-in for Temporal's operator service. `onAdd` runs before the add is applied, so a test can
 * simulate another pod registering in the same window; `failAdd` makes the add itself fail.
 */
function fakeOperator(
  initial: Record<string, number> = {},
  options: { onAdd?: () => void; failAdd?: Error } = {},
) {
  const attributes: Record<string, number> = { ...initial };
  const listSearchAttributes = vi.fn(() =>
    Promise.resolve({ customAttributes: { ...attributes } }),
  );
  const addSearchAttributes = vi.fn((request: { searchAttributes: Record<string, number> }) => {
    options.onAdd?.();
    if (options.failAdd !== undefined) return Promise.reject(options.failAdd);
    Object.assign(attributes, request.searchAttributes);
    return Promise.resolve({});
  });
  const operator: SearchAttributeOperator = { listSearchAttributes, addSearchAttributes };
  return { operator, attributes, listSearchAttributes, addSearchAttributes };
}

function recorder() {
  const results: SearchAttributeRegistrationResult[] = [];
  return { results, record: (result: SearchAttributeRegistrationResult) => results.push(result) };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('planSearchAttributeRegistration', () => {
  it('names every IndexedValueType wire value exactly as the Temporal enum does', () => {
    for (const [name, value] of Object.entries(temporal.api.enums.v1.IndexedValueType) as [
      string,
      number,
    ][]) {
      const { conflicts } = planSearchAttributeRegistration({ runState: value });
      // Only the Keyword value matches the registered type; every other wire value must be reported by its name.
      const expected =
        value === KEYWORD ? [] : [{ name: 'runState', expected: 'Keyword', actual: name }];
      expect(conflicts).toEqual(expected);
    }
  });

  it('plans all three attributes when none is registered', () => {
    expect(planSearchAttributeRegistration({})).toEqual({
      toCreate: { tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD },
      conflicts: [],
    });
  });

  it('plans nothing when all three are registered with the right type', () => {
    expect(
      planSearchAttributeRegistration({ tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD }),
    ).toEqual({
      toCreate: {},
      conflicts: [],
    });
  });

  it('plans only the missing attributes', () => {
    expect(planSearchAttributeRegistration({ runId: KEYWORD }).toCreate).toEqual({
      tenantId: KEYWORD,
      runState: KEYWORD,
    });
  });

  it('reports an attribute registered with another type as a conflict and plans nothing for it', () => {
    const plan = planSearchAttributeRegistration({
      tenantId: INT,
      runId: KEYWORD,
      runState: KEYWORD,
    });
    expect(plan.toCreate).toEqual({});
    expect(plan.conflicts).toEqual([
      { name: 'tenantId', expected: 'Keyword', actual: 'INDEXED_VALUE_TYPE_INT' },
    ]);
  });

  it('treats the unspecified type as a conflict, not as a match', () => {
    const plan = planSearchAttributeRegistration({ runState: 0 });
    expect(plan.conflicts).toEqual([
      { name: 'runState', expected: 'Keyword', actual: 'INDEXED_VALUE_TYPE_UNSPECIFIED' },
    ]);
  });

  it('treats a null entry as missing and ignores attributes it does not manage', () => {
    const plan = planSearchAttributeRegistration({ runId: null, assessmentId: INT });
    expect(plan.toCreate).toEqual({ tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD });
    expect(plan.conflicts).toEqual([]);
  });
});

describe('registerSearchAttributes', () => {
  it('creates the missing attributes on an empty namespace and reports created', async () => {
    const { operator, attributes, addSearchAttributes } = fakeOperator();
    const { results, record } = recorder();

    const outcome = await registerSearchAttributes({
      operator,
      namespace: NAMESPACE,
      recordResult: record,
    });

    expect(outcome).toEqual({ result: 'created', created: ['tenantId', 'runId', 'runState'] });
    expect(addSearchAttributes).toHaveBeenCalledTimes(1);
    expect(addSearchAttributes).toHaveBeenCalledWith({
      namespace: NAMESPACE,
      searchAttributes: { tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD },
    });
    expect(attributes).toEqual({ tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD });
    expect(results).toEqual(['created']);
  });

  it('is a no-op on the second run: nothing is added and the result is unchanged', async () => {
    const { operator, addSearchAttributes } = fakeOperator();
    await registerSearchAttributes({
      operator,
      namespace: NAMESPACE,
      recordResult: () => undefined,
    });
    addSearchAttributes.mockClear();
    const { results, record } = recorder();

    const outcome = await registerSearchAttributes({
      operator,
      namespace: NAMESPACE,
      recordResult: record,
    });

    expect(outcome).toEqual({ result: 'unchanged', created: [] });
    expect(addSearchAttributes).not.toHaveBeenCalled();
    expect(results).toEqual(['unchanged']);
  });

  it('adds only what is missing and leaves existing attributes and unknown ones alone', async () => {
    const { operator, attributes, addSearchAttributes } = fakeOperator({
      tenantId: KEYWORD,
      assessmentId: KEYWORD,
    });

    const outcome = await registerSearchAttributes({
      operator,
      namespace: NAMESPACE,
      recordResult: () => undefined,
    });

    expect(outcome.created).toEqual(['runId', 'runState']);
    expect(addSearchAttributes).toHaveBeenCalledWith({
      namespace: NAMESPACE,
      searchAttributes: { runId: KEYWORD, runState: KEYWORD },
    });
    expect(attributes).toEqual({
      tenantId: KEYWORD,
      assessmentId: KEYWORD,
      runId: KEYWORD,
      runState: KEYWORD,
    });
  });

  it('fails loudly on a type conflict, names the attribute, and writes nothing (never drops or retypes)', async () => {
    const { operator, attributes, addSearchAttributes } = fakeOperator({ tenantId: INT });
    const { results, record } = recorder();

    const error = await catchError(
      registerSearchAttributes({ operator, namespace: NAMESPACE, recordResult: record }),
    );

    expect(isAppError(error) && error.code).toBe('SEARCH_ATTR_TYPE_CONFLICT');
    expect(error instanceof Error && error.message).toContain(
      'tenantId is INDEXED_VALUE_TYPE_INT, expected Keyword',
    );
    expect(addSearchAttributes).not.toHaveBeenCalled();
    expect(attributes).toEqual({ tenantId: INT });
    expect(results).toEqual(['conflict']);
  });

  it('refuses the conflict even when other attributes are missing, so nothing is partially registered', async () => {
    const { operator, attributes, addSearchAttributes } = fakeOperator({ runState: INT });

    await expect(
      registerSearchAttributes({ operator, namespace: NAMESPACE, recordResult: () => undefined }),
    ).rejects.toMatchObject({ code: 'SEARCH_ATTR_TYPE_CONFLICT' });
    expect(addSearchAttributes).not.toHaveBeenCalled();
    expect(attributes).toEqual({ runState: INT });
  });

  it('treats a race with another pod (same attributes added in between) as success', async () => {
    // The other pod's registration lands while our add is in flight, and then our add fails.
    const { operator, addSearchAttributes, attributes } = fakeOperator(
      {},
      {
        onAdd: () =>
          Object.assign(attributes, { tenantId: KEYWORD, runId: KEYWORD, runState: KEYWORD }),
        failAdd: new Error('already exists'),
      },
    );
    const { results, record } = recorder();

    const outcome = await registerSearchAttributes({
      operator,
      namespace: NAMESPACE,
      recordResult: record,
    });

    expect(outcome).toEqual({ result: 'unchanged', created: [] });
    expect(addSearchAttributes).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['unchanged']);
  });

  it('surfaces the original add failure when the attributes are still missing afterwards', async () => {
    const addError = new Error('visibility store does not support custom search attributes');
    const { operator } = fakeOperator({}, { failAdd: addError });
    const { results, record } = recorder();

    const error = await catchError(
      registerSearchAttributes({ operator, namespace: NAMESPACE, recordResult: record }),
    );

    expect(error).toBe(addError);
    expect(results).toEqual(['failed']);
  });

  it('surfaces a conflict introduced by a concurrent registration instead of the add failure', async () => {
    const { operator, attributes } = fakeOperator(
      {},
      {
        onAdd: () => Object.assign(attributes, { tenantId: INT }),
        failAdd: new Error('already exists'),
      },
    );
    const { results, record } = recorder();

    await expect(
      registerSearchAttributes({ operator, namespace: NAMESPACE, recordResult: record }),
    ).rejects.toMatchObject({ code: 'SEARCH_ATTR_TYPE_CONFLICT' });
    expect(results).toEqual(['conflict']);
  });

  it('records a failed result and rethrows when the listing itself fails', async () => {
    const listError = new Error('namespace not found');
    const operator: SearchAttributeOperator = {
      listSearchAttributes: () => Promise.reject(listError),
      addSearchAttributes: () => Promise.resolve({}),
    };
    const { results, record } = recorder();

    const error = await catchError(
      registerSearchAttributes({ operator, namespace: NAMESPACE, recordResult: record }),
    );

    expect(error).toBe(listError);
    expect(results).toEqual(['failed']);
  });
});
