import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { parseSurfaceQuery } from './query.js';

describe('parseSurfaceQuery', () => {
  it('applies the defaults: every kind, no confidence floor, a page of 100', () => {
    expect(parseSurfaceQuery({})).toEqual({ minConfidence: 0, inScopeOnly: false, limit: 100 });
  });

  it('reads the in-scope-only switch as a strict true or false', () => {
    expect(parseSurfaceQuery({ inScopeOnly: 'true' }).inScopeOnly).toBe(true);
    expect(parseSurfaceQuery({ inScopeOnly: 'false' }).inScopeOnly).toBe(false);
    expect(() => parseSurfaceQuery({ inScopeOnly: '1' })).toThrow(AppError);
    expect(() => parseSurfaceQuery({ inScopeOnly: 'TRUE' })).toThrow(AppError);
  });

  it('parses a kind list, a confidence floor, a limit and a cursor', () => {
    expect(
      parseSurfaceQuery({
        kinds: 'host, service,host',
        minConfidence: '.5',
        limit: '200',
        cursor: 'abc.def',
      }),
    ).toEqual({
      kinds: ['host', 'service'],
      minConfidence: 0.5,
      inScopeOnly: false,
      limit: 200,
      cursor: 'abc.def',
    });
  });

  it.each([
    ['an unknown kind', { kinds: 'host,database' }],
    ['an empty kind list', { kinds: '' }],
    ['a kind with only commas', { kinds: ',' }],
    ['a confidence above 1', { minConfidence: '1.5' }],
    ['a negative confidence', { minConfidence: '-0.1' }],
    ['a non-numeric confidence', { minConfidence: 'high' }],
    ['a non-numeric limit', { limit: 'ten' }],
    ['a fractional limit', { limit: '2.5' }],
    ['a zero limit', { limit: '0' }],
    ['a limit over the cap', { limit: '201' }],
    ['an empty cursor', { cursor: '' }],
    ['a cursor over the length cap', { cursor: 'a'.repeat(2049) }],
  ])('refuses %s with INVALID_QUERY (400)', (_name, raw) => {
    let error: unknown;
    try {
      parseSurfaceQuery(raw);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_QUERY');
    expect((error as AppError).httpStatus).toBe(400);
  });
});
