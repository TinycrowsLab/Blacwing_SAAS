import { describe, expect, it } from 'vitest';

import { createApiClient } from './api-client';
import {
  assessmentWizardKeys,
  createAssessmentRequestApi,
  ifMatchFor,
} from './assessment-request-api';

import type { AssessmentRequestResponse } from '@blackwing/contracts';

const TENANT_REQUEST_ID = 'areq_01m64cavacexhrddgjb6xd80xv';
const ASSET = '0198f0a0-0000-7000-8000-0000000000e1';

const DRAFT: AssessmentRequestResponse = {
  id: TENANT_REQUEST_ID,
  status: 'draft',
  mode: 'grey',
  objective: 'Test the login flow',
  assetIds: [ASSET],
  saId: null,
  inputManifestId: null,
  scopeRules: {},
  maxIntrusiveness: 'active_safe',
  budgets: { costCapUsd: 5, maxRequests: 5000, maxDurationMs: 3600000 },
  trigger: 'console',
  requestedBy: '0198f0a0-0000-7000-8000-0000000000a1',
  stateVersion: 3,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly ifMatch: string | null;
  readonly body: string | null;
}

/** A fake `fetch` that records each request and answers the given JSON body. */
function recordingFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      ifMatch: headers.get('If-Match'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ETag: `"v${String(DRAFT.stateVersion)}"` },
      }),
    );
  };
  return { fetch: fake, calls };
}

describe('assessment-request API client (scoping wizard)', () => {
  it('reads a draft from the BFF path', async () => {
    const rec = recordingFetch(DRAFT);
    const api = createAssessmentRequestApi(createApiClient({ fetch: rec.fetch, baseUrl: '/v1' }));
    const draft = await api.get(TENANT_REQUEST_ID);
    expect(draft.id).toBe(TENANT_REQUEST_ID);
    expect(rec.calls[0]?.url).toBe(`/v1/assessment-requests/${TENANT_REQUEST_ID}`);
    expect(rec.calls[0]?.method).toBe('GET');
  });

  it('rejects a malformed draft id before any request is sent', () => {
    const rec = recordingFetch(DRAFT);
    const api = createAssessmentRequestApi(createApiClient({ fetch: rec.fetch, baseUrl: '/v1' }));
    expect(() => api.get('../admin')).toThrow();
    expect(rec.calls).toHaveLength(0);
  });

  it('sends a PATCH with If-Match taken from the version the caller last read', async () => {
    const rec = recordingFetch({ ...DRAFT, mode: 'white' });
    const api = createAssessmentRequestApi(createApiClient({ fetch: rec.fetch, baseUrl: '/v1' }));
    await api.patch(TENANT_REQUEST_ID, 3, { mode: 'white' });
    expect(rec.calls[0]?.method).toBe('PATCH');
    expect(rec.calls[0]?.ifMatch).toBe('"v3"');
    expect(JSON.parse(rec.calls[0]?.body ?? 'null')).toEqual({ mode: 'white' });
  });

  it('creates the draft with a POST to the collection', async () => {
    const rec = recordingFetch(DRAFT);
    const api = createAssessmentRequestApi(createApiClient({ fetch: rec.fetch, baseUrl: '/v1' }));
    await api.create({ mode: 'grey', assetIds: [ASSET], objective: 'Test the login flow' });
    expect(rec.calls[0]?.url).toBe('/v1/assessment-requests');
    expect(rec.calls[0]?.method).toBe('POST');
    expect(JSON.parse(rec.calls[0]?.body ?? 'null')).toMatchObject({
      mode: 'grey',
      assetIds: [ASSET],
    });
  });

  it('lists the tenant assets from the assets path', async () => {
    const rec = recordingFetch({
      items: [
        {
          id: ASSET,
          name: 'Juice Shop',
          type: 'web_app',
          environment: 'dev',
          verificationStatus: 'verified',
        },
      ],
    });
    const api = createAssessmentRequestApi(createApiClient({ fetch: rec.fetch, baseUrl: '/v1' }));
    const list = await api.assets();
    expect(list.items[0]?.verificationStatus).toBe('verified');
    expect(rec.calls[0]?.url).toBe('/v1/assets');
  });

  it('formats the If-Match value as the server ETag and keys the draft cache by its id', () => {
    expect(ifMatchFor(0)).toBe('"v0"');
    expect(ifMatchFor(12)).toBe('"v12"');
    expect(assessmentWizardKeys.draft(TENANT_REQUEST_ID)).toEqual([
      'assessment-wizard',
      'draft',
      TENANT_REQUEST_ID,
    ]);
  });
});
