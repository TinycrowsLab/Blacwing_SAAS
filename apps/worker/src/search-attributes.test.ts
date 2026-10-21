import { upsertSearchAttributes } from '@temporalio/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runStateSchema } from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';

import {
  RUN_STATE_VALUES,
  runStartSearchAttributes,
  runStateSearchAttributes,
  SEARCH_ATTRIBUTES,
  upsertRunSearchAttributes,
} from './search-attributes.js';

vi.mock('@temporalio/workflow', () => ({ upsertSearchAttributes: vi.fn() }));

const VALID = { tenantId: 't-acme', runId: 'run_0195c0de-1234', runState: 'planning' } as const;

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('SEARCH_ATTRIBUTES', () => {
  it('declares exactly tenantId, runId and runState as Keyword attributes', () => {
    expect(SEARCH_ATTRIBUTES).toEqual({
      tenantId: 'Keyword',
      runId: 'Keyword',
      runState: 'Keyword',
    });
  });
});

describe('RUN_STATE_VALUES', () => {
  it('matches the run state machine in @blackwing/contracts exactly', () => {
    expect([...RUN_STATE_VALUES]).toEqual([...runStateSchema.options]);
  });
});

describe('runStartSearchAttributes', () => {
  it('maps a run identity to the keyword lists the SDK expects on workflow start', () => {
    expect(runStartSearchAttributes(VALID)).toEqual({
      tenantId: ['t-acme'],
      runId: ['run_0195c0de-1234'],
      runState: ['planning'],
    });
  });

  it.each([
    ['empty tenantId', { ...VALID, tenantId: '' }],
    ['tenantId longer than 255 characters', { ...VALID, tenantId: 'a'.repeat(256) }],
    ['tenantId with whitespace', { ...VALID, tenantId: 't acme' }],
    ['tenantId with a control character', { ...VALID, tenantId: 't\nacme' }],
    ['tenantId with non-ASCII characters', { ...VALID, tenantId: 'tênant' }],
    ['tenantId with a colon (query-syntax injection)', { ...VALID, tenantId: 'a" or runId = "b' }],
    ['empty runId', { ...VALID, runId: '' }],
    ['runId with a slash (path-like value)', { ...VALID, runId: 'run/../other' }],
  ])('refuses %s with VALIDATION_FAILED', (_label, input) => {
    const error = catchError(() => runStartSearchAttributes(input));
    expect(isAppError(error) && error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts identifiers at the 255-character limit', () => {
    const edge = 'a'.repeat(255);
    expect(
      runStartSearchAttributes({ ...VALID, tenantId: 'a.b_c-d', runId: '0195c0de-1234-7abc' }),
    ).toEqual({
      tenantId: ['a.b_c-d'],
      runId: ['0195c0de-1234-7abc'],
      runState: ['planning'],
    });
    expect(runStartSearchAttributes({ ...VALID, tenantId: edge, runId: edge }).tenantId).toEqual([
      edge,
    ]);
  });

  it('fails closed on a run state that is not in the run state machine', () => {
    for (const runState of ['EXECUTING', 'running', '', 'executing ']) {
      const error = catchError(() =>
        runStartSearchAttributes({ ...VALID, runState: runState as 'draft' }),
      );
      expect(isAppError(error) && error.code, runState).toBe('VALIDATION_FAILED');
    }
  });
});

describe('runStateSearchAttributes', () => {
  it('writes only the runState attribute', () => {
    expect(runStateSearchAttributes('executing')).toEqual({ runState: ['executing'] });
  });

  it('refuses an unknown state instead of indexing it', () => {
    const error = catchError(() => runStateSearchAttributes('hacked' as 'draft'));
    expect(isAppError(error) && error.code).toBe('VALIDATION_FAILED');
  });
});

describe('upsertRunSearchAttributes', () => {
  beforeEach(() => {
    vi.mocked(upsertSearchAttributes).mockClear();
  });

  it('upserts the runState attribute through the workflow API', () => {
    upsertRunSearchAttributes('awaiting_gate1');
    expect(upsertSearchAttributes).toHaveBeenCalledTimes(1);
    expect(upsertSearchAttributes).toHaveBeenCalledWith({ runState: ['awaiting_gate1'] });
  });

  it('writes nothing when the state is invalid', () => {
    const error = catchError(() => {
      upsertRunSearchAttributes('bogus' as 'draft');
    });
    expect(isAppError(error) && error.code).toBe('VALIDATION_FAILED');
    expect(upsertSearchAttributes).not.toHaveBeenCalled();
  });
});
