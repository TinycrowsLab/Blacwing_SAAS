// The HTTP side of Keycloak's back-channel logout (#336): reads the `logout_token` form field from a
// server-to-server POST. The token is the credential, so the form is not CSRF-protected; a cross-site
// form cannot forge a token Keycloak signed. The body is capped before it is parsed.

const MAX_BODY_BYTES = 8192;
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** The `logout_token` of a request, or `undefined` when the body is not a bounded logout form. */
export async function logoutTokenOf(request: Request): Promise<string | undefined> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith(FORM_TYPE)) return undefined;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return undefined;
  const token = new URLSearchParams(body).get('logout_token');
  return token === null || token === '' ? undefined : token;
}
