import { describe, expect, it } from 'vitest';

import {
  WHITEBOX_MAX_LEADS_DEFAULT,
  WHITEBOX_MAX_LEADS_LIMIT,
  whiteboxEnvSchema,
} from './whitebox.js';

describe('whiteboxEnvSchema', () => {
  it('defaults WHITEBOX_MAX_LEADS to 200 when unset', () => {
    expect(whiteboxEnvSchema.parse({}).WHITEBOX_MAX_LEADS).toBe(200);
    expect(WHITEBOX_MAX_LEADS_DEFAULT).toBe(200);
  });

  it('accepts a positive integer up to the limit', () => {
    expect(whiteboxEnvSchema.parse({ WHITEBOX_MAX_LEADS: '25' }).WHITEBOX_MAX_LEADS).toBe(25);
    expect(
      whiteboxEnvSchema.parse({ WHITEBOX_MAX_LEADS: String(WHITEBOX_MAX_LEADS_LIMIT) })
        .WHITEBOX_MAX_LEADS,
    ).toBe(WHITEBOX_MAX_LEADS_LIMIT);
  });

  it.each(['0', '-1', '+5', '01', '2.5', '1e3', 'abc', '', ' 7'])(
    'fails closed on %j instead of clamping',
    (raw) => {
      expect(whiteboxEnvSchema.safeParse({ WHITEBOX_MAX_LEADS: raw }).success).toBe(false);
    },
  );

  it('rejects values above the limit', () => {
    const result = whiteboxEnvSchema.safeParse({
      WHITEBOX_MAX_LEADS: String(WHITEBOX_MAX_LEADS_LIMIT + 1),
    });
    expect(result.success).toBe(false);
  });
});
