import { AppError } from '@blackwing/errors';

/**
 * What the Keycloak organisations service needs to reach the realm. The client secret is deliberately absent:
 * it is read by reference from OpenBao at `secretPath` (CONTEXT_PACK §8 #7), never from the environment.
 */
export interface KeycloakAdminSettings {
  /** Keycloak origin without a trailing slash, e.g. `https://id.example.test`. */
  readonly baseUrl: string;
  readonly realm: string;
  /** The dedicated least-privilege service-account client (organisation and member management only). */
  readonly clientId: string;
  /** OpenBao KV v2 read path that holds the client secret under `client_secret`. */
  readonly secretPath: string;
}

/** The `KEYCLOAK_*` keys of the API environment (see `apps/api/src/config.ts`). */
export interface KeycloakAdminEnv {
  readonly KEYCLOAK_ADMIN_URL?: string | undefined;
  readonly KEYCLOAK_ADMIN_REALM?: string | undefined;
  readonly KEYCLOAK_ORG_ADMIN_CLIENT_ID?: string | undefined;
  readonly KEYCLOAK_ORG_ADMIN_SECRET_PATH?: string | undefined;
}

/** `secret/data/platform/keycloak/org-admin`: plain path segments only, so no traversal or query injection. */
const SECRET_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/;

/**
 * Builds the settings or refuses to start (fail closed). All four keys are required together: a partly
 * configured organisation admin must never fall back to anything else.
 */
export function keycloakAdminSettingsFrom(env: KeycloakAdminEnv): KeycloakAdminSettings {
  const url = env.KEYCLOAK_ADMIN_URL;
  const realm = env.KEYCLOAK_ADMIN_REALM;
  const clientId = env.KEYCLOAK_ORG_ADMIN_CLIENT_ID;
  const secretPath = env.KEYCLOAK_ORG_ADMIN_SECRET_PATH;
  if (
    url === undefined ||
    realm === undefined ||
    clientId === undefined ||
    secretPath === undefined ||
    !SECRET_PATH.test(secretPath)
  ) {
    throw new AppError(
      'CONFIG_INVALID',
      'Keycloak organisation admin needs KEYCLOAK_ADMIN_URL, KEYCLOAK_ADMIN_REALM, KEYCLOAK_ORG_ADMIN_CLIENT_ID and a valid KEYCLOAK_ORG_ADMIN_SECRET_PATH',
    );
  }
  return { baseUrl: url.replace(/\/+$/, ''), realm, clientId, secretPath };
}
