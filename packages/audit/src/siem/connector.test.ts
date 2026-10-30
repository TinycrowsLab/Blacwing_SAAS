import { describe, expect, it } from 'vitest';

import { assertNoSecretsInConfig, SiemConfigError } from './connector.js';

/** The value a call throws, or `undefined` when it returns normally. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('connector config contract', () => {
  it('a secret-bearing config raises the stable config error', () => {
    const error = thrownBy(() => {
      assertNoSecretsInConfig({ authorization: 'Bearer x' });
    });
    expect(error).toBeInstanceOf(SiemConfigError);
    expect((error as SiemConfigError).code).toBe('VALIDATION_FAILED');
  });
});
