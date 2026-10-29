// DEMO-STORY unit tests: the pure rules of the demo API (no database): role mapping and the refusal codes.
import { describe, expect, it } from 'vitest';

import { actorHasRole, fingerprintFor } from './service.js';

describe('actorHasRole', () => {
  it('accepts the Keycloak dash form and the seed underscore form', () => {
    const dashed = { id: 'u1', email: 'a@acme.test', name: 'A', roles: ['asset-owner'] };
    const underscored = { id: 'u2', email: 'b@acme.test', name: 'B', roles: ['appsec_engineer'] };
    expect(actorHasRole(dashed, 'asset-owner')).toBe(true);
    expect(actorHasRole(underscored, 'appsec-engineer')).toBe(true);
    expect(actorHasRole(dashed, 'appsec-engineer')).toBe(false);
  });
});

describe('fingerprintFor', () => {
  it('is stable for the same parts and differs when a part changes', () => {
    expect(fingerprintFor(['a', 'b'])).toBe(fingerprintFor(['a', 'b']));
    expect(fingerprintFor(['a', 'b'])).not.toBe(fingerprintFor(['a', 'c']));
    expect(fingerprintFor(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });
});
