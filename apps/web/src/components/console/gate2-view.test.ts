import { describe, expect, it } from 'vitest';

import { gate2Question, plainWhy, roleFromPathKey } from './gate2-view';

describe('Gate 2 question', () => {
  it('reads the role from the worker gate key', () => {
    expect(roleFromPathKey('POST https://shop.example/rest/basket/7/checkout as customer_a')).toBe('customer_a');
    expect(roleFromPathKey('POST http://x.test/rest/user/login as no test account')).toBeNull();
    expect(roleFromPathKey('')).toBeNull();
  });

  it('asks with the role, or without signing in', () => {
    expect(gate2Question('customer_a')).toBe('Allow Claude to send this request as customer_a?');
    expect(gate2Question(null)).toBe('Allow Claude to send this request without signing in?');
  });

  it('names the authorisation level by the label people chose it by', () => {
    expect(plainWhy('POST is a state-changing method; the authorisation covers only active-safe requests.')).toBe(
      'POST is a state-changing method; the authorisation covers only “Probe gently” requests.',
    );
  });
});
