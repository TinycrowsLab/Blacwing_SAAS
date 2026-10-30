import { describe, expect, it } from 'vitest';

import { idpHintOf } from './idp-hint';

describe('idpHintOf', () => {
  it('allow-lists only google', () => {
    expect(idpHintOf('google')).toBe('google');
    expect(idpHintOf('GOOGLE')).toBeUndefined();
    expect(idpHintOf('github')).toBeUndefined();
    expect(idpHintOf('google&prompt=none')).toBeUndefined();
    expect(idpHintOf('')).toBeUndefined();
    expect(idpHintOf(null)).toBeUndefined();
  });
});
