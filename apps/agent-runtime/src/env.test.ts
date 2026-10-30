import { describe, expect, it } from 'vitest';

import { loadRuntimeEnv, PDP_TIMEOUT_MS_DEFAULT } from './env.js';

const BASE = { BW_SESSION_DESCRIPTOR: '/run/session.json' };

describe('runtime environment (RUNTIME-005)', () => {
  it('defaults the PDP timeout to 1500 ms', () => {
    expect(PDP_TIMEOUT_MS_DEFAULT).toBe(1500);
    expect(loadRuntimeEnv(BASE).BW_PDP_TIMEOUT_MS).toBe(1500);
  });

  it('reads BW_PDP_TIMEOUT_MS as an integer within bounds', () => {
    expect(loadRuntimeEnv({ ...BASE, BW_PDP_TIMEOUT_MS: '250' }).BW_PDP_TIMEOUT_MS).toBe(250);
  });

  it.each(['0', '-5', '60001', 'soon', '1.5'])(
    'refuses BW_PDP_TIMEOUT_MS=%s (fail fast)',
    (value) => {
      expect(() => loadRuntimeEnv({ ...BASE, BW_PDP_TIMEOUT_MS: value })).toThrow();
    },
  );
});
