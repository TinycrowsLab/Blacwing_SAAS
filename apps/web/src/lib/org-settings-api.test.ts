import { describe, expect, it } from 'vitest';

import { createApiClient } from './api-client';
import { createOrgSettingsApi, ORG_PROFILE_PATH } from './org-settings-api';

const PROFILE = {
  name: 'Acme Security',
  slug: 'acme',
  region: 'eu-west-1',
  plan: 'team',
  status: 'active',
  defaultTimezone: 'Europe/Berlin',
  supportContactEmail: null,
  updatedAt: '2026-10-01T10:00:00.000Z',
};

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** The request body as text: the client always sends JSON strings. */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

/** A fake `fetch` that records each call and answers with `handler`. */
function fakeFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const fetch = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, etag: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ETag: etag },
  });
}

describe('createOrgSettingsApi', () => {
  it('reads the profile on the tenant route with no tenant identifier in the request', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(PROFILE, '"aaaaaaaaaaaaaaaa"'));
    const api = createOrgSettingsApi(createApiClient({ fetch, baseUrl: '/v1' }));
    expect(await api.get()).toEqual(PROFILE);
    expect(calls[0]?.url).toBe(`/v1${ORG_PROFILE_PATH}`);
  });

  it('sends the ETag of the last read as If-Match on the write', async () => {
    const etag = '"aaaaaaaaaaaaaaaa"';
    const { fetch, calls } = fakeFetch((call) =>
      call.init?.method === 'PATCH'
        ? jsonResponse({ ...PROFILE, name: 'Renamed' }, '"bbbbbbbbbbbbbbbb"')
        : jsonResponse(PROFILE, etag),
    );
    const api = createOrgSettingsApi(createApiClient({ fetch, baseUrl: '/v1' }));
    await api.get();
    const saved = await api.update({ name: 'Renamed' });
    expect(saved.name).toBe('Renamed');
    const patch = calls[1]?.init;
    expect(patch?.method).toBe('PATCH');
    expect((patch?.headers as Record<string, string>)['If-Match']).toBe(etag);
    expect(JSON.parse(bodyText(patch))).toEqual({ name: 'Renamed' });
  });

  it('refuses a response that does not match the contract (never coerced)', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ ...PROFILE, tenantId: 'leaked' }, '"aaaaaaaaaaaaaaaa"'),
    );
    const api = createOrgSettingsApi(createApiClient({ fetch, baseUrl: '/v1' }));
    await expect(api.get()).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});
