// DEMO-STORY first-login provisioning for Google sign-ins (demo mode only; mounted with the demo controller).
// Keycloak gives a Google user the demo tenant, the requester and read roles and this marker role (the Google
// IdP mappers, see scripts/keycloak-google-idp.mjs). The marker is granted only by those mappers, so a local
// Keycloak user never reaches the provisioning path unless an administrator assigns the role by hand.
export const GOOGLE_DEMO_MARKER_ROLE = 'bw-demo-google';

/** True when the presented, Keycloak-verified roles say this is a first-time Google sign-in for the demo. */
export function isGoogleDemoSignIn(input: {
  readonly roles: readonly string[];
  readonly sub: string | undefined;
  readonly email: string;
}): boolean {
  return (
    input.roles.includes(GOOGLE_DEMO_MARKER_ROLE) &&
    input.sub !== undefined &&
    input.sub !== '' &&
    input.email !== ''
  );
}
