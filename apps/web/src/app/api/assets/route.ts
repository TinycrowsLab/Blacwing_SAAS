// The workspace's targets, for duplicate detection while someone types a web address ("You already added this site").
import { z } from 'zod';

import { getAsUser } from '../../../lib/post-route';
import { assetSchema } from '../../../lib/schemas';

export const dynamic = 'force-dynamic';

const listSchema = z.object({ items: z.array(assetSchema) });

export function GET(): Promise<Response> {
  return getAsUser('/assets', (body) => listSchema.parse(body));
}
