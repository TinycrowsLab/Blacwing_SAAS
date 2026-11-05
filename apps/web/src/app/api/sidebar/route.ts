// The sidebar's poll (every 5 s while visible, and on `bw:refresh`): the dashboard slice it shows, nothing more.
import { getAsUser } from '../../../lib/post-route';
import { dashboardSchema, toSidebar } from '../../../lib/schemas';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return getAsUser('/dashboard', (body) => toSidebar(dashboardSchema.parse(body)));
}
