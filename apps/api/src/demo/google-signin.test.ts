import { describe, expect, it } from 'vitest';

import { isGoogleDemoSignIn } from './google-signin.js';

describe('isGoogleDemoSignIn', () => {
  const base = {
    roles: ['appsec-engineer', 'auditor', 'bw-demo-google'],
    sub: 'sub-1',
    email: 'g@example.test',
  };

  it('provisions only for the marker role with a subject and an e-mail', () => {
    expect(isGoogleDemoSignIn(base)).toBe(true);
  });

  it('refuses a local user without the marker, even with the same roles', () => {
    expect(isGoogleDemoSignIn({ ...base, roles: ['appsec-engineer', 'auditor'] })).toBe(false);
  });

  it('refuses a marker without a subject or e-mail', () => {
    expect(isGoogleDemoSignIn({ ...base, sub: undefined })).toBe(false);
    expect(isGoogleDemoSignIn({ ...base, sub: '' })).toBe(false);
    expect(isGoogleDemoSignIn({ ...base, email: '' })).toBe(false);
  });
});
