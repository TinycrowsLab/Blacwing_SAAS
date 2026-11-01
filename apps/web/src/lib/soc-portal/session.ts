// The scoped SOC portal session (SOCUI-001, #553). A verified link sets one httpOnly cookie that holds
// the link's own claims, sealed (AES-256-GCM, purpose-bound) so the browser can read neither the
// tenant nor the asset ids. It is not a console session: it opens only the (soc) routes, and it
// expires with the link (never later than the link's `exp`).

import { type SocPortalClaims, socPortalClaimsSchema } from './token.js';
import { SOC_PORTAL_COOKIE, serializeCookie } from '../auth/cookies.js';
import { open, seal } from '../auth/seal.js';

/** The seal purpose: a value sealed for another purpose (a console session) never opens here. */
const SOC_PORTAL_PURPOSE = 'soc-portal-session';

const MS_PER_SECOND = 1000;

/** The cookie `Set-Cookie` value for a verified link, lasting until the link's `exp`. */
export function sealPortalSession(
  sessionKey: Buffer,
  claims: SocPortalClaims,
  nowSeconds: number,
): string {
  const ttlMs = (claims.exp - nowSeconds) * MS_PER_SECOND;
  const sealed = seal(sessionKey, SOC_PORTAL_PURPOSE, claims, ttlMs, nowSeconds * MS_PER_SECOND);
  return serializeCookie(SOC_PORTAL_COOKIE, sealed, claims.exp - nowSeconds);
}

/**
 * The claims behind a portal cookie value, or `null` when it is absent, forged, corrupt, expired or
 * sealed for another purpose. The expiry is enforced by the seal itself (`exp`).
 */
export function openPortalSession(
  sessionKey: Buffer,
  cookieValue: string | undefined,
  nowSeconds: number,
): SocPortalClaims | null {
  if (cookieValue === undefined || cookieValue === '') return null;
  const payload = open([sessionKey], SOC_PORTAL_PURPOSE, cookieValue, nowSeconds * MS_PER_SECOND);
  const parsed = socPortalClaimsSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
