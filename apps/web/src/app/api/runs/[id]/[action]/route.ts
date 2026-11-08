// The browser's run controls: pause, resume and kill (kill carries {scope, confirm}), and the recorded exchanges
// (GET .../exchanges?afterSeq=n, one page of the requests and responses for the Requests tab and the call sheet).
import { z } from 'zod';

import { exchangeListSchema } from '../../../../../components/console/run-model';
import { getAsUser, postAsUser, refuseMutation } from '../../../../../lib/post-route';

export const dynamic = 'force-dynamic';

const actionSchema = z.enum(['pause', 'resume', 'kill']);
const killBodySchema = z.object({ scope: z.literal('run'), confirm: z.string().min(1) }).strict();
const MAX_SEQ = 1_000_000;
const afterSeqSchema = z.coerce.number().int().min(0).max(MAX_SEQ).catch(0);

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string; readonly action: string }> },
): Promise<Response> {
  const { id, action } = await params;
  if (action !== 'exchanges') return Response.json({ code: 'not_found' }, { status: 404 });
  const afterSeq = afterSeqSchema.parse(new URL(request.url).searchParams.get('afterSeq') ?? 0);
  return getAsUser(`/runs/${encodeURIComponent(id)}/exchanges?afterSeq=${afterSeq}`, (body) => exchangeListSchema.parse(body));
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string; readonly action: string }> },
): Promise<Response> {
  const { id, action } = await params;
  const parsed = actionSchema.safeParse(action);
  const refused = refuseMutation(request, { json: parsed.data === 'kill' });
  if (refused !== null) return refused;
  if (!parsed.success) return Response.json({ code: 'not_found' }, { status: 404 });
  const path = `/runs/${encodeURIComponent(id)}/${parsed.data}`;
  if (parsed.data !== 'kill') return postAsUser(path, undefined);
  const body = killBodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  return postAsUser(path, body.data);
}
