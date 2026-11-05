// The browser's Gate 2 decision (transcript card and decision page). The API enforces the deadline and the role.
import { z } from 'zod';

import { postAsUser } from '../../../../_lib/post-route';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ decision: z.enum(['approve', 'deny']) }).strict();

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  return postAsUser(`/gate2/${encodeURIComponent(id)}/decision`, body.data);
}
