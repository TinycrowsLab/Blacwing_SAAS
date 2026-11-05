'use server';

// Demo server actions. Each one runs as the signed-in user (the Keycloak session) and calls the demo API.
// A refusal (separation of duties, budget, scope...) comes back as ?error=<code>&message=<detail> on the page.
import { redirect } from 'next/navigation';

import { DemoApiError, demoApi } from './_lib/demo-api';
import { getSession } from '../../lib/session';

const enc = encodeURIComponent;
const SECONDS_PER_MINUTE = 60;

function refuse(path: string, error: unknown): never {
  const code = error instanceof DemoApiError ? error.code : 'demo_error';
  const message =
    error instanceof DemoApiError ? error.message : 'The demo API could not complete the action.';
  const sep = path.includes('?') ? '&' : '?';
  redirect(`${path}${sep}error=${enc(code)}&message=${enc(message)}`);
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/** A textarea of origins or paths: one per line or comma separated, blanks dropped. */
function list(form: FormData, key: string): string[] {
  return text(form, key)
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

async function requireSession() {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  return session;
}

export async function createAssetAction(form: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await demoApi(session, '/assets', {
      method: 'POST',
      body: {
        name: text(form, 'name'),
        baseUrl: text(form, 'baseUrl'),
        extraOrigins: list(form, 'extraOrigins'),
        excludedPaths: list(form, 'excludedPaths'),
      },
    });
  } catch (error) {
    refuse('/demo/assets', error);
  }
  redirect('/demo/assets');
}

export async function verifyAssetAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = text(form, 'assetId');
  const statement = text(form, 'statement');
  try {
    await demoApi(session, `/assets/${enc(id)}/verify`, {
      method: 'POST',
      body:
        statement === '' ? { method: 'http_token' } : { method: 'owner_attestation', statement },
    });
  } catch (error) {
    refuse('/demo/assets', error);
  }
  redirect('/demo/assets');
}

export async function createRequestAction(form: FormData): Promise<void> {
  const session = await requireSession();
  let created: { id: string } | null = null;
  try {
    created = await demoApi<{ id: string }>(session, '/requests', {
      method: 'POST',
      body: {
        assetId: text(form, 'assetId'),
        objective: text(form, 'objective'),
        intrusiveness: text(form, 'intrusiveness'),
        budgetRequests: Number(text(form, 'budgetRequests')),
        budgetSeconds: Number(text(form, 'budgetMinutes')) * SECONDS_PER_MINUTE,
        costCapUsd: Number(text(form, 'costCapUsd')),
        excludedPaths: list(form, 'excludedPaths'),
        testAccounts: [0, 1, 2]
          .map((i) => ({
            role: text(form, `ta_role_${i}`),
            headerName: text(form, `ta_header_${i}`),
            headerValue: text(form, `ta_value_${i}`),
          }))
          .filter((a) => a.role !== ''),
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

export async function triageFindingAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = text(form, 'findingId');
  const decision = text(form, 'decision') === 'dismiss' ? 'dismiss' : 'release';
  try {
    await demoApi(session, `/findings/${enc(id)}/triage`, {
      method: 'POST',
      body: { decision, reason: text(form, 'reason') },
    });
  } catch (error) {
    refuse(`/demo/findings/${enc(id)}`, error);
  }
  redirect(`/demo/findings/${enc(id)}`);
}
