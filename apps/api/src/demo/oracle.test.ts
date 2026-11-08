import { describe, expect, it } from 'vitest';

import { scrubOracle } from './service.js';

describe('scrubOracle', () => {
  it('describes a check that names a secret field instead of mangling it', () => {
    const out = scrubOracle({ type: 'body_contains', value: '"password": "hunter2"' });
    expect(out.value).toBe('text that names the field "password" with its value hidden');
  });
  it('keeps a harmless check as written', () => {
    const oracle = { type: 'body_contains', value: 'root:x:0:0' };
    expect(scrubOracle(oracle)).toEqual(oracle);
  });
});
