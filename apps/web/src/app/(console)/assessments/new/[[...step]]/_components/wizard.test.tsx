// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssessmentWizard } from './wizard';

import type { AssessmentRequestResponse } from '@blackwing/contracts';

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

const REQUEST_ID = 'areq_01m64cavacexhrddgjb6xd80xv';
const ASSET = '0198f0a0-0000-7000-8000-0000000000e1';

function draft(overrides: Partial<AssessmentRequestResponse> = {}): AssessmentRequestResponse {
  return {
    id: REQUEST_ID,
    status: 'draft',
    mode: 'grey',
    objective: '',
    assetIds: [],
    saId: null,
    inputManifestId: null,
    scopeRules: {},
    maxIntrusiveness: 'active_safe',
    budgets: { costCapUsd: 5, maxRequests: 5000, maxDurationMs: 3600000 },
    trigger: 'console',
    requestedBy: '0198f0a0-0000-7000-8000-0000000000a1',
    stateVersion: 2,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderWizard(props: Parameters<typeof AssessmentWizard>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssessmentWizard {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssessmentWizard (resume, deep links and conflicts)', () => {
  it('redirects a deep link to a later step of an incomplete draft to the first incomplete step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(draft({ mode: 'grey', assetIds: [] })))),
    );
    renderWizard({
      step: 'objective',
      requestId: REQUEST_ID,
      urlAnswers: { mode: null, assetIds: [] },
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(`/assessments/new/assets?request=${REQUEST_ID}`);
    });
  });

  it('resumes a saved draft at its step with the saved values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(json(draft({ mode: 'white', assetIds: [ASSET], objective: 'Check auth' }))),
      ),
    );
    renderWizard({
      step: 'objective',
      requestId: REQUEST_ID,
      urlAnswers: { mode: null, assetIds: [] },
    });
    expect(await screen.findByRole('heading', { name: 'State the objective' })).toBeTruthy();
    const field = screen.getByLabelText<HTMLTextAreaElement>('Objective');
    expect(field.value).toBe('Check auth');
    expect(replace).not.toHaveBeenCalled();
  });

  it('saves a step with If-Match and shows the reload prompt when another tab changed the draft (412)', async () => {
    const user = userEvent.setup();
    const seen: { method: string; ifMatch: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ method: init?.method ?? 'GET', ifMatch: headers.get('If-Match') });
        if (init?.method === 'PATCH') {
          return Promise.resolve(
            json(
              { type: 'about:blank', title: 'Precondition failed', status: 412, detail: 'stale' },
              412,
            ),
          );
        }
        return Promise.resolve(json(draft({ mode: 'grey', assetIds: [ASSET] })));
      }),
    );
    renderWizard({
      step: 'mode',
      requestId: REQUEST_ID,
      urlAnswers: { mode: null, assetIds: [] },
    });
    await screen.findByRole('heading', { name: 'Choose the assessment mode' });
    await user.click(screen.getByRole('radio', { name: /White box/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'This draft changed in another tab. Nothing was overwritten.',
    );
    expect(screen.getByRole('button', { name: 'Reload draft' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    const patch = seen.find((call) => call.method === 'PATCH');
    expect(patch?.ifMatch).toBe('"v2"');
  });
});
