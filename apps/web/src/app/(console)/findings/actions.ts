'use server';

// Console server actions. Each one runs as the signed-in administrator and calls the API.
// A refusal (separation of duties, budget, scope...) comes back as ?error=<code>&message=<detail> on the page.
import { redirect } from 'next/navigation';

import { ApiError, callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';

const enc = encodeURIComponent;

function refuse(path: string, error: unknown): never {
  const code = error instanceof ApiError ? error.code : 'request_failed';
  const message =
    error instanceof ApiError ? error.message : 'The API could not complete the action.';
  const sep = path.includes('?') ? '&' : '?';
  redirect(`${path}${sep}error=${enc(code)}&message=${enc(message)}`);
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

async function requireSession() {
  const session = await getViewer();
  if (session === null) redirect('/login');
  return session;
}

export async function triageFindingAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = text(form, 'findingId');
  const decision = text(form, 'decision') === 'dismiss' ? 'dismiss' : 'release';
  try {
    await callApi(session, `/findings/${enc(id)}/triage`, {
      method: 'POST',
      body: { decision, reason: text(form, 'reason') },
    });
  } catch (error) {
    refuse(`/findings/${enc(id)}`, error);
  }
  redirect(`/findings/${enc(id)}`);
}
