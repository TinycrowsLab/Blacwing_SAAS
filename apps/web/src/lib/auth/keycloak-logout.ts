// Keycloak Admin API call that ends a user's Keycloak sessions (#336): `POST /admin/realms/<realm>/users/<id>/logout`.
// Without it a user revoked here could sign straight back in through their still-live SSO session. The
// service-account token is requested with `client_credentials` per call (revocations are rare) and is
// never logged or returned. Only Keycloak's answer is classified: 204 and 404 both mean the user has no
// Keycloak session left.

import { IdpRejectedError, IdpUnavailableError } from './oidc.js';

import type { IdpSessionLogout } from './revocation.js';

const REQUEST_TIMEOUT_MS = 5000;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const REALM_ISSUER = /^(.+)\/realms\/([^/]+)$/;

export interface KeycloakSessionLogoutConfig {
  /** The realm issuer, `<keycloak>/realms/<realm>`. */
  readonly issuer: string;
  /** The dedicated service-account client that may log users out (`manage-users` in the realm). */
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface KeycloakSessionLogoutDeps {
  readonly fetch: typeof fetch;
}

/** Builds the port over the Keycloak Admin REST API; the URLs are derived from the realm issuer. */
export function createKeycloakSessionLogout(
  config: KeycloakSessionLogoutConfig,
  deps: KeycloakSessionLogoutDeps,
): IdpSessionLogout {
  const match = REALM_ISSUER.exec(config.issuer);
  if (match === null) throw new Error('The realm issuer does not name a realm');
  const keycloakOrigin = match[1] ?? '';
  const realm = match[2] ?? '';
  const tokenUrl = `${config.issuer}/protocol/openid-connect/token`;
  const adminUrl = `${keycloakOrigin}/admin/realms/${encodeURIComponent(realm)}/users`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        ...init,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new IdpUnavailableError();
    }
    if (response.status >= HTTP_SERVER_ERROR) throw new IdpUnavailableError();
    return response;
  }

  async function serviceToken(): Promise<string> {
    const response = await send(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    const json: unknown = await response.json().catch(() => null);
    const token =
      typeof json === 'object' && json !== null && 'access_token' in json
        ? json.access_token
        : undefined;
    if (!response.ok || typeof token !== 'string' || token === '') {
      throw new IdpRejectedError('client_credentials');
    }
    return token;
  }

  return {
    async logoutUser(sub) {
      const token = await serviceToken();
      const response = await send(`${adminUrl}/${encodeURIComponent(sub)}/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === HTTP_NO_CONTENT || response.status === HTTP_OK) return;
      if (response.status === HTTP_NOT_FOUND) return;
      throw new IdpRejectedError(`admin_${String(response.status)}`);
    },
  };
}
