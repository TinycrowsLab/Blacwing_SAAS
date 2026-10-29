'use server';

// DEMO-STORY server actions. Each one runs as the signed-in user (the Keycloak session) and calls the demo API.
// A refusal (separation of duties, budget, scope...) comes back as ?error=<code>&message=<detail> on the page.
import { redirect } from 'next/navigation';

import { DemoApiError, demoApi } from './_lib/demo-api';
import { getSession } from '../../lib/session';

const enc = encodeURIComponent;

function refuse(path: string, error: unknown): never {
  const code = error instanceof DemoApiError ? error.code : 'demo_error';
  const message = error instanceof DemoApiError ? error.message : 'The demo API could not complete the action.';
  const sep = path.includes('?') ? '&' : '?';
  redirect(`${path}${sep}error=${enc(code)}&message=${enc(message)}`);
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function createRequestAction(form: FormData): Promise<void> {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  const assetId = text(form, 'assetId');
  let created: { id: string } | null = null;
  try {
    created = await demoApi<{ id: string }>(session, '/requests', {
      method: 'POST',
      body: {
        assetId,
        testCaseId: text(form, 'testCaseId'),
        intrusiveness: text(form, 'intrusiveness'),
        budgetRequests: Number(text(form, 'budgetRequests')),
        budgetSeconds: Number(text(form, 'budgetSeconds')),
        scope: { host: text(form, 'scopeHost'), pathPrefix: text(form, 'scopePath') },
      },
    });
  } catch (error) {
    refuse('/demo/requests/new', error);
  }
  redirect(`/demo/requests/${created.id}`);
}

export async function decideRequestAction(form: FormData): Promise<void> {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  const id = text(form, 'requestId');
  const decision = text(form, 'decision') === 'reject' ? 'reject' : 'approve';
  const reason = text(form, 'reason');
  try {
    await demoApi(session, `/requests/${enc(id)}/decision`, {
      method: 'POST',
      body: { decision, reason: reason === '' ? null : reason },
    });
  } catch (error) {
    refuse(`/demo/requests/${enc(id)}`, error);
  }
  redirect(`/demo/requests/${enc(id)}`);
}

export async function startRunAction(form: FormData): Promise<void> {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  const id = text(form, 'requestId');
  let run: { id: string } | null = null;
  try {
    run = await demoApi<{ id: string }>(session, `/requests/${enc(id)}/runs`, { method: 'POST' });
  } catch (error) {
    refuse(`/demo/requests/${enc(id)}`, error);
  }
  redirect(`/demo/runs/${run.id}`);
}
