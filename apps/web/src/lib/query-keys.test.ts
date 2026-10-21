import { describe, expect, it } from 'vitest';

import { createResourceKeys, qk } from './query-keys.js';

describe('query keys', () => {
  it('is stable regardless of filter property order and drops undefined', () => {
    expect(qk.runs.list({ b: 2, a: 1, c: undefined })).toEqual(qk.runs.list({ a: 1, b: 2 }));
    expect(JSON.stringify(qk.runs.list({ b: 2, a: 1 }))).toBe('["runs","list",{"a":1,"b":2}]');
  });

  it('is serialisable and prefix-nested under all', () => {
    expect(qk.runs.all).toEqual(['runs']);
    expect(qk.runs.lists()).toEqual(['runs', 'list']);
    expect(qk.runs.detail('run_1')).toEqual(['runs', 'detail', 'run_1']);
    expect(qk.runs.list()).toEqual(['runs', 'list', {}]);
    expect(structuredClone(qk.runs.detail('x'))).toEqual(qk.runs.detail('x'));
  });

  it('keeps resources separate', () => {
    expect(createResourceKeys('findings').detail('f1')).not.toEqual(qk.runs.detail('f1'));
  });
});
