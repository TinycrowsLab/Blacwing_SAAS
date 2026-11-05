// One finding, for expand-in-place on the results page (experience spec §7): the API answer parsed with Zod.
import { findingDetailSchema } from '../../../../components/console/results/model';
import { getAsUser } from '../../../../lib/post-route';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  return getAsUser(`/findings/${encodeURIComponent(id)}`, (body) => findingDetailSchema.parse(body));
}
