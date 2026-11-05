// The browser's run controls: pause, resume and kill (kill carries {scope, confirm}).
import { z } from 'zod';

import { postAsUser } from '../../../../../lib/post-route';

export const dynamic = 'force-dynamic';

const actionSchema = z.enum(['pause', 'resume', 'kill']);
const killBodySchema = z.object({ scope: z.literal('run'), confirm: z.string().min(1) }).strict();

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string; readonly action: string }> },
): Promise<Response> {
  const { id, action } = await params;
  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) return Response.json({ code: 'not_found' }, { status: 404 });
  const path = `/runs/${encodeURIComponent(id)}/${parsed.data}`;
  if (parsed.data !== 'kill') return postAsUser(path, undefined);
  const body = killBodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  return postAsUser(path, body.data);
}
