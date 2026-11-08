// The Stop dialog's wider blast radius: every audit on one target, or every audit in the workspace, in one call.
// One audit stays on /api/runs/:id/kill. The API checks the typed name and writes the ledger.
import { z } from 'zod';

import { postAsUser, refuseMutation } from '../../../lib/post-route';

export const dynamic = 'force-dynamic';

const NAME_MAX = 120;
const bodySchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('target'), assetId: z.uuid(), confirm: z.string().min(1).max(NAME_MAX) }),
  z.strictObject({ scope: z.literal('workspace'), confirm: z.string().min(1).max(NAME_MAX) }),
]);

export async function POST(request: Request): Promise<Response> {
  const refused = refuseMutation(request, { json: true });
  if (refused !== null) return refused;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  return postAsUser('/kill', body.data);
}
