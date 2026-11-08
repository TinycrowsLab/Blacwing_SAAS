'use server';

// Emergency stop links (Settings and the Stop dialog) and the workspace's emergency contact. Administrators only; the
// API records each create, revoke and contact change on the ledger. The new link's token is returned once, to the
// administrator who created it, and never stored.
import { z } from 'zod';

import { callApi, toResult, type ActionResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { emergencyLinkSchema, type EmergencyContact, type EmergencyLink } from '../../../lib/schemas';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmergencyValidity = '1h' | '24h' | '7d';

const signedOut = {
  ok: false,
  code: 'unauthenticated',
  message: 'Your session ended. Sign in again.',
  status: HTTP_UNAUTHORIZED,
} as const;

const createdSchema = z.object({ link: emergencyLinkSchema, token: z.string() });

export async function createEmergencyLinkAction(
  validity: EmergencyValidity,
  label: string,
): Promise<ActionResult<{ link: EmergencyLink; token: string }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  return toResult(async () =>
    createdSchema.parse(
      await callApi(session, '/emergency-links', {
        method: 'POST',
        body: { validity, label: label.trim().replace(/\s+/g, ' ') },
      }),
    ),
  );
}

export async function revokeEmergencyLinkAction(id: string): Promise<ActionResult<null>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  if (!UUID.test(id)) return { ok: false, code: 'not_found', message: 'No such link.', status: HTTP_NOT_FOUND };
  return toResult(async () => {
    await callApi(session, `/emergency-links/${id}/revoke`, { method: 'POST' });
    return null;
  });
}

export async function setEmergencyContactAction(contact: EmergencyContact | null): Promise<ActionResult<null>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  return toResult(async () => {
    await callApi(session, '/workspace/emergency-contact', { method: 'POST', body: { contact } });
    return null;
  });
}
