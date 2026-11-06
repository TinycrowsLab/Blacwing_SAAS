// The browser's run controls: pause, resume and kill (kill carries {scope, confirm}), and the recorded exchanges
// (GET .../exchanges?afterSeq=n, one page of the requests and responses for the Requests tab and the call sheet).
import { z } from 'zod';

import { exchangeListSchema } from '../../../../../components/console/run-model';
import { getAsUser, postAsUser } from '../../../../../lib/post-route';

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

/**
 * Defence in depth on top of the SameSite session cookie: a run control only comes from this console's own pages.
 * Browsers send Sec-Fetch-Site (and Origin) on every POST; another site, even a sibling localhost port, is refused.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).host !== (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return true;
  }
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string; readonly action: string }> },
): Promise<Response> {
  if (crossSite(request)) return Response.json({ code: 'cross_site', message: 'Run controls only work from Blackwing itself.' }, { status: 403 });
  const { id, action } = await params;
  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) return Response.json({ code: 'not_found' }, { status: 404 });
  const path = `/runs/${encodeURIComponent(id)}/${parsed.data}`;
  if (parsed.data !== 'kill') return postAsUser(path, undefined);
  const body = killBodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  return postAsUser(path, body.data);
}
