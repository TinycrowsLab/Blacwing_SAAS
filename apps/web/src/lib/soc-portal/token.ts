// The signed SOC portal link (SOCUI-001, #553): a compact Ed25519 JWS (packages/crypto) whose claims
// name the tenant, the assets and the expiry. It is verified here, in the BFF, and never trusted in
// the browser. A link is a bearer capability by design, so it is short-lived and single-tenant.

import { z } from 'zod';

import { uuidV7Schema } from '@blackwing/contracts';
import { type JwsKeyResolver, verifyJws } from '@blackwing/crypto';

const SOC_PORTAL_SCOPE = 'soc_portal';
/** Longest a link may live: 72 hours, the default in the portal spec. */
export const SOC_PORTAL_MAX_TTL_SECONDS = 259_200;
/** Clock skew tolerated on `exp`, in both directions (60 s, as the kill link). */
export const SOC_PORTAL_LEEWAY_SECONDS = 60;
/** The most assets one link may name. */
export const SOC_PORTAL_MAX_ASSETS = 50;
/** A link is a path segment; refuse anything larger before parsing (50 asset ids fit well inside). */
export const SOC_PORTAL_MAX_TOKEN_BYTES = 8192;

/** The signed claims of a portal link. Strict: an unknown claim makes the whole link invalid. */
export const socPortalClaimsSchema = z.strictObject({
  tenantId: uuidV7Schema,
  scope: z.literal(SOC_PORTAL_SCOPE),
  assetIds: z.array(uuidV7Schema).min(1).max(SOC_PORTAL_MAX_ASSETS),
  jti: uuidV7Schema,
  /** Epoch seconds. */
  exp: z.int().positive(),
});
export type SocPortalClaims = z.infer<typeof socPortalClaimsSchema>;

/**
 * Why a link was refused. `invalid` covers every defect (malformed, bad signature, unknown key,
 * wrong scope, bad claims, over-long lifetime), so a caller cannot probe which check failed.
 */
export type SocPortalRejectReason = 'invalid' | 'expired';

export type SocPortalVerdict =
  | { readonly ok: true; readonly claims: SocPortalClaims }
  | { readonly ok: false; readonly reason: SocPortalRejectReason };

/**
 * Verifies a portal link against `resolveKey` at `nowSeconds`. Fails closed on any defect. The
 * `expired` answer is only given for a genuine, correctly signed link that is past `exp` plus leeway.
 */
export function verifySocPortalLink(
  token: string,
  resolveKey: JwsKeyResolver,
  nowSeconds: number,
): SocPortalVerdict {
  if (token.length > SOC_PORTAL_MAX_TOKEN_BYTES) return { ok: false, reason: 'invalid' };
  const verified = verifyJws(token, resolveKey, SOC_PORTAL_MAX_TOKEN_BYTES);
  if (verified === null) return { ok: false, reason: 'invalid' };
  const parsed = socPortalClaimsSchema.safeParse(verified.payload);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const claims = parsed.data;
  // A lifetime longer than the maximum (plus leeway) is never issued, so it is refused as forged.
  if (claims.exp - nowSeconds > SOC_PORTAL_MAX_TTL_SECONDS + SOC_PORTAL_LEEWAY_SECONDS) {
    return { ok: false, reason: 'invalid' };
  }
  if (nowSeconds > claims.exp + SOC_PORTAL_LEEWAY_SECONDS) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
