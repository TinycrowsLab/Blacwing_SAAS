// The Add target preview's live check: would the API refuse this address? (read only; the same rules as adding it)
import { z } from 'zod';

import { getAsUser } from '../../../lib/post-route';

export const dynamic = 'force-dynamic';

const MAX_URL = 2048;
const originSchema = z.url({ protocol: /^https?$/ }).max(MAX_URL);
const answerSchema = z.object({ refusal: z.string().nullable() });

export function GET(request: Request): Promise<Response> {
  const origin = originSchema.safeParse(new URL(request.url).searchParams.get('origin'));
  if (!origin.success) return Promise.resolve(Response.json({ code: 'invalid_origin' }, { status: 400 }));
  return getAsUser(`/target-check?origin=${encodeURIComponent(origin.data)}`, (body) => answerSchema.parse(body));
}
