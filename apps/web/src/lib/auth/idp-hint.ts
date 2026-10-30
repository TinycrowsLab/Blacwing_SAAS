// The identity providers the login page may start directly (Keycloak `kc_idp_hint`). Google is brokered by
// Keycloak only; the app never talks to Google. Any other value is ignored, never reflected or forwarded.
export const ALLOWED_IDP_HINTS = ['google'] as const;

export type IdpHint = (typeof ALLOWED_IDP_HINTS)[number];

/** The allow-listed hint for a raw `idp` query value, or `undefined` (ignored) for anything else. */
export function idpHintOf(raw: string | null): IdpHint | undefined {
  return (ALLOWED_IDP_HINTS as readonly string[]).includes(raw ?? '')
    ? (raw as IdpHint)
    : undefined;
}
