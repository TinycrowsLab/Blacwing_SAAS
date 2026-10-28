import { describe, expect, it, vi } from 'vitest';

import { harness, sessionRecord, type Harness } from './auth.test-helpers.js';
import { IdpRejectedError, IdpUnavailableError } from './oidc.js';
import { createSessionRevoker, type IdpSessionLogout } from './revocation.js';

function idp(logoutUser: IdpSessionLogout['logoutUser']): IdpSessionLogout & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    logoutUser: (sub) => {
      calls.push(sub);
      return logoutUser(sub);
    },
  };
}

function revoker(h: Harness, idpPort?: IdpSessionLogout) {
  const warnings: unknown[] = [];
  const sleeps: number[] = [];
  const service = createSessionRevoker({
    store: h.store,
    metrics: { sessionRevocation: (scope) => h.metrics.revocations.push(scope) },
    audit: (event) => h.audit.push(event),
    idp: idpPort,
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { service, warnings, sleeps };
}

describe('revokeSessions', () => {
  it('ends a user’s sessions, leaves other users alone, and logs the user out at Keycloak', async () => {
    const h = harness();
    await h.store.create('a', sessionRecord, 60_000);
    await h.store.create('b', { ...sessionRecord, sub: 'user-2' }, 60_000);
    const port = idp(() => Promise.resolve());
    const { service } = revoker(h, port);

    const result = await service.revokeSessions({ userId: 'user-1', reason: 'user_disabled' });

    expect(result).toEqual({ sessions: 1, idpLogout: 'done' });
    expect(await h.store.get('a')).toBeNull();
    expect(await h.store.get('b')).not.toBeNull();
    expect(port.calls).toEqual(['user-1']);
    expect(h.audit).toEqual([
      {
        action: 'auth.session_revoked',
        outcome: 'success',
        userId: 'user-1',
        tenantId: 'tenant-1',
        reason: 'user_disabled',
      },
    ]);
    expect(h.metrics.revocations).toEqual(['user']);
  });

  it('kills every session of a tenant, and logs out each user it ended at Keycloak once', async () => {
    const h = harness();
    await h.store.create('a', sessionRecord, 60_000);
    await h.store.create('b', sessionRecord, 60_000);
    await h.store.create('c', { ...sessionRecord, sub: 'user-2' }, 60_000);
    await h.store.create('other', { ...sessionRecord, tenantId: 'tenant-2' }, 60_000);
    const port = idp(() => Promise.resolve());
    const { service } = revoker(h, port);

    const result = await service.revokeSessions({
      tenantId: 'tenant-1',
      reason: 'tenant_suspended',
    });

    expect(result).toEqual({ sessions: 3, idpLogout: 'done' });
    expect(await h.store.get('other')).not.toBeNull();
    expect(port.calls.sort()).toEqual(['user-1', 'user-2']);
    expect(h.audit).toHaveLength(3);
    expect(h.metrics.revocations).toEqual(['tenant']);
  });

  it('limits a user-and-tenant revocation to that tenant', async () => {
    const h = harness();
    await h.store.create('here', sessionRecord, 60_000);
    await h.store.create('there', { ...sessionRecord, tenantId: 'tenant-2' }, 60_000);
    const { service } = revoker(h);

    const result = await service.revokeSessions({
      userId: 'user-1',
      tenantId: 'tenant-2',
      reason: 'admin_revoked',
    });

    expect(result.sessions).toBe(1);
    expect(await h.store.get('here')).not.toBeNull();
    expect(await h.store.get('there')).toBeNull();
    expect(h.metrics.revocations).toEqual(['user_tenant']);
  });

  it('still logs a user out at Keycloak when the BFF holds no session for them', async () => {
    const h = harness();
    const port = idp(() => Promise.resolve());
    const { service } = revoker(h, port);

    const result = await service.revokeSessions({ userId: 'user-9', reason: 'admin_revoked' });

    expect(result).toEqual({ sessions: 0, idpLogout: 'done' });
    expect(port.calls).toEqual(['user-9']);
  });

  it('reports Keycloak as skipped, and warns, when no admin client is configured', async () => {
    const h = harness();
    await h.store.create('a', sessionRecord, 60_000);
    const { service, warnings } = revoker(h, undefined);

    const result = await service.revokeSessions({ userId: 'user-1', reason: 'admin_revoked' });

    expect(result).toEqual({ sessions: 1, idpLogout: 'skipped' });
    expect(await h.store.get('a')).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('retries a Keycloak logout with backoff and succeeds on a later attempt', async () => {
    const h = harness();
    const logout = vi
      .fn<IdpSessionLogout['logoutUser']>()
      .mockRejectedValueOnce(new IdpUnavailableError())
      .mockResolvedValueOnce(undefined);
    const { service, sleeps } = revoker(h, { logoutUser: logout });

    const result = await service.revokeSessions({ userId: 'user-1', reason: 'user_disabled' });

    expect(result.idpLogout).toBe('done');
    expect(logout).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([200]);
  });

  it('gives up after bounded attempts and reports failed, while the BFF sessions stay ended', async () => {
    const h = harness();
    await h.store.create('a', sessionRecord, 60_000);
    const logout = vi.fn<IdpSessionLogout['logoutUser']>(() =>
      Promise.reject(new IdpRejectedError('admin_500')),
    );
    const { service, warnings, sleeps } = revoker(h, { logoutUser: logout });

    const result = await service.revokeSessions({ userId: 'user-1', reason: 'user_disabled' });

    expect(result).toEqual({ sessions: 1, idpLogout: 'failed' });
    expect(logout).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 400]);
    expect(await h.store.get('a')).toBeNull();
    expect(warnings).toHaveLength(1);
    // Logged with ids and the error type only, never a token.
    expect(JSON.stringify(warnings)).not.toContain('plain-');
  });

  it('propagates a Valkey outage: nothing is reported as revoked', async () => {
    const h = harness();
    h.valkey.failing = true;
    const { service } = revoker(
      h,
      idp(() => Promise.resolve()),
    );
    await expect(
      service.revokeSessions({ userId: 'user-1', reason: 'user_disabled' }),
    ).rejects.toThrow('The session store is unavailable');
    expect(h.audit).toEqual([]);
  });
});
