// Who may see the SOC portal (SOCUI-001, #553). Two paths, both server-side: a logged-in SOC seat (the
// Keycloak `soc` role, through the normal console session), or a scoped portal session from a verified
// link. Nothing here is decided in the browser, and a link session never widens to console routes.

import type { Session } from '../session.js';
import type { SocPortalClaims } from './token.js';

/** The Keycloak role that lets a SOC seat use the portal with a normal Blackwing login. */
const SOC_SEAT_ROLE = 'soc';

export type PortalAccess =
  | { readonly kind: 'seat'; readonly tenantSlug: string; readonly userName: string }
  | { readonly kind: 'link'; readonly claims: SocPortalClaims }
  | { readonly kind: 'none' };

export interface PortalAccessInput {
  readonly session: Session | null;
  readonly linkClaims: SocPortalClaims | null;
}

/**
 * The portal view for this request. A `soc` seat wins (its own, normal auth), then a live link
 * session. Anything else is `none`, which the page turns into the expired-link state.
 */
export function resolvePortalAccess(input: PortalAccessInput): PortalAccess {
  const { session, linkClaims } = input;
  if (session?.roles.includes(SOC_SEAT_ROLE) === true) {
    return { kind: 'seat', tenantSlug: session.tenant.slug, userName: session.user.name };
  }
  if (linkClaims !== null) return { kind: 'link', claims: linkClaims };
  return { kind: 'none' };
}
