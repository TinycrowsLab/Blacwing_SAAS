import { describe, expect, it } from 'vitest';

import { loginErrorMessage } from './login-error.js';

describe('loginErrorMessage', () => {
  it('maps every callback failure code to a message', () => {
    for (const code of [
      'invalid_state',
      'denied',
      'exchange_failed',
      'invalid_token',
      'no_tenant',
      'idp_unavailable',
      'store_unavailable',
    ]) {
      expect(loginErrorMessage(code)).toBeTruthy();
    }
  });

  it('shows nothing for anything else, including prototype keys', () => {
    for (const code of ['', 'x', '<script>', 'constructor', '__proto__', 'toString']) {
      expect(loginErrorMessage(code)).toBeUndefined();
    }
  });
});
