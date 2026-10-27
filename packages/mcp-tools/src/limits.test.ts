import { describe, expect, it } from 'vitest';

import { DEFAULT_TOOL_OUTPUT_MAX_BYTES, resolveOutputMaxBytes } from './limits.js';

describe('resolveOutputMaxBytes', () => {
  it('defaults to 131072', () => {
    expect(DEFAULT_TOOL_OUTPUT_MAX_BYTES).toBe(131_072);
    expect(resolveOutputMaxBytes({})).toBe(131_072);
    expect(resolveOutputMaxBytes({ BW_TOOL_OUTPUT_MAX_BYTES: '' })).toBe(131_072);
  });

  it('reads BW_TOOL_OUTPUT_MAX_BYTES', () => {
    expect(resolveOutputMaxBytes({ BW_TOOL_OUTPUT_MAX_BYTES: '4096' })).toBe(4096);
  });

  it.each(['abc', '-1', '1.5', '1e6', '0', '1023', '99999999999', '16777217'])(
    'rejects %s instead of running unbounded',
    (value) => {
      expect(() => resolveOutputMaxBytes({ BW_TOOL_OUTPUT_MAX_BYTES: value })).toThrow(RangeError);
    },
  );
});
