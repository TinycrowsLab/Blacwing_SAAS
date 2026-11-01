import { openSocPortalLink } from '../../../../lib/soc-portal/link-open';
import { getSocPortalLinkDeps } from '../../../../lib/soc-portal/runtime';

// The BFF entry for a SOC portal link (SOCUI-001, #553). The link is a credential: this handler is never
// cached, and it answers with a redirect so the token is not left in the page the visitor sees.
export const dynamic = 'force-dynamic';

export function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ token: string }> },
): Promise<Response> {
  return params.then(({ token }) => openSocPortalLink(token, getSocPortalLinkDeps()));
}
