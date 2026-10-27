import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './api-client.js';
import { isApiError } from './api-error.js';
import { createOperatorKillApi } from './operator-kill-api.js';

const TENANT = '01890a5d-ac96-774b-bcce-b302099a8057';
const EVENT = '01890a5d-ac96-774b-bcce-b302099a8058';
const AT = '2026-10-20T10:00:00.000Z';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

function setup(response: Response) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response),
  );
  const api = createOperatorKillApi(
    createApiClient({ baseUrl: '/operator/v1', fetch: fetchMock as unknown as typeof fetch }),
  );
  const call = (): { url: string; init: RequestInit } => {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return { url: url ?? '', init: init ?? {} };
  };
  return { api, call };
}

describe('operator kill API client', () => {
  it('asks for the global blast radius without a tenant', async () => {
    const { api, call } = setup(
      json({ runsAffected: 1, sandboxesAffected: 2, tenantsAffected: 1, sessionsAffected: 3 }),
    );
    await expect(api.blastRadius('global', undefined)).resolves.toMatchObject({ runsAffected: 1 });
    expect(call().url).toBe('/operator/v1/kill/blast-radius?scope=global');
  });

  it('names the tenant explicitly for a tenant blast radius', async () => {
    const { api, call } = setup(
      json({
        runsAffected: 0,
        sandboxesAffected: 0,
        tenantsAffected: 0,
        sessionsAffected: 0,
        tenantSlug: 'acme',
      }),
    );
    await expect(api.blastRadius('tenant', TENANT)).resolves.toMatchObject({ tenantSlug: 'acme' });
    expect(call().url).toBe(`/operator/v1/kill/blast-radius?scope=tenant&tenantId=${TENANT}`);
  });

  it('fires with the given Idempotency-Key and the exact body', async () => {
    const { api, call } = setup(
      json({ killEventId: EVENT, status: 'initiated', triggeredAt: AT }, 202),
    );
    const request = { scope: 'tenant', tenantId: TENANT, reason: 'incident' } as const;
    await expect(api.fire(request, 'key-from-the-panel')).resolves.toMatchObject({
      killEventId: EVENT,
    });
    const { url, init } = call();
    expect(url).toBe('/operator/v1/kill');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-from-the-panel');
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('lists events and reads one, validating the contract', async () => {
    const summary = {
      id: EVENT,
      scope: 'global',
      tenantId: null,
      actor: 'op-1',
      reason: 'incident',
      firedAt: AT,
      haltMs: 3300,
      status: 'halted',
    };
    const listed = setup(json({ items: [summary] }));
    await expect(listed.api.events()).resolves.toEqual([summary]);
    expect(listed.call().url).toBe('/operator/v1/kill/events');

    const one = setup(
      json({
        ...summary,
        egressBlockedAt: AT,
        sandboxesTerminatedAt: AT,
        keysRevokedAt: AT,
        workflowsCancelledAt: AT,
        completedAt: AT,
        affected: {},
      }),
    );
    await expect(one.api.event(EVENT)).resolves.toMatchObject({ id: EVENT, haltMs: 3300 });
    expect(one.call().url).toBe(`/operator/v1/kill/events/${EVENT}`);
  });

  it('rejects a response that does not match the contract instead of showing it', async () => {
    const { api } = setup(json({ items: [{ id: 'not-a-uuid' }] }));
    await expect(api.events()).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('surfaces the problem code of a refusal', async () => {
    const { api } = setup(
      json(
        {
          type: 'https://errors.blackwing.dev/NOT_OPERATOR',
          title: 'Platform operator required',
          status: 403,
          code: 'NOT_OPERATOR',
          traceId: 't1',
        },
        403,
      ),
    );
    const error = await api.events().catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, code: 'NOT_OPERATOR' });
  });
});
