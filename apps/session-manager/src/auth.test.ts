import { describe, expect, it } from 'vitest';

import { assertScope, isProtectedPath, PROTECTED_PREFIX } from './auth.js';
import { SmTenantMismatchError, SmUnauthenticatedError } from './errors.js';

const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f5a0-0000-7000-8000-000000000002';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';
const OTHER_RUN = '0192f5a0-0000-7000-8000-0000000000bb';

const runPrincipal = { kind: 'run', tenantId: TENANT, runId: RUN, expiresAt: 1 } as const;
const controlPrincipal = { kind: 'control', tenantId: TENANT, expiresAt: 1 } as const;

describe('assertScope', () => {
  it('refuses an absent principal as unauthenticated', () => {
    expect(() => assertScope(null, { tenantId: TENANT })).toThrow(SmUnauthenticatedError);
  });

  it('lets a control-plane token reach its own tenant-level route', () => {
    expect(assertScope(controlPrincipal, { tenantId: TENANT })).toBe(controlPrincipal);
  });

  it('lets a run-scoped token reach its own run under its own tenant', () => {
    expect(assertScope(runPrincipal, { tenantId: TENANT, runId: RUN })).toBe(runPrincipal);
  });

  it.each([
    ['a control token for another tenant', controlPrincipal, { tenantId: OTHER_TENANT }],
    ['a run token for another tenant', runPrincipal, { tenantId: OTHER_TENANT, runId: RUN }],
    [
      'a run token for another run of its tenant',
      runPrincipal,
      { tenantId: TENANT, runId: OTHER_RUN },
    ],
    ['a run token on a tenant-level route', runPrincipal, { tenantId: TENANT }],
    ['a control token on a run route', controlPrincipal, { tenantId: TENANT, runId: RUN }],
  ] as const)('refuses %s with SM_TENANT_MISMATCH', (_label, principal, scope) => {
    expect(() => assertScope(principal, scope)).toThrow(SmTenantMismatchError);
  });
});

describe('isProtectedPath', () => {
  it.each([
    '/internal/sessions',
    '/internal/sessions/',
    '/internal/sessions/tenants/x/scope',
    '/INTERNAL/Sessions/anything',
    '//internal///sessions/x',
    '/internal/sessions/%2e%2e/x',
    '/internal/sessions?x=1',
  ])('protects %s', (url) => {
    expect(isProtectedPath(url)).toBe(true);
  });

  it('protects an undecodable path (fail closed)', () => {
    expect(isProtectedPath('/%E0%A4%A')).toBe(true);
  });

  it.each(['/healthz', '/readyz', '/metrics', '/internal/sessionsx', '/internal/other'])(
    'leaves %s unprotected',
    (url) => {
      expect(isProtectedPath(url)).toBe(false);
    },
  );

  it('uses the internal sessions prefix', () => {
    expect(PROTECTED_PREFIX).toBe('/internal/sessions');
  });
});
