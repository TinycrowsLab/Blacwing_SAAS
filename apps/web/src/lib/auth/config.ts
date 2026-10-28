// BFF auth configuration (IAM-002, #334), read once through @blackwing/config (fail fast, secrets
// registered for redaction). Staging and production require https for the issuer and the console
// origin; the cookies are `Secure` in every environment.

import { z } from 'zod';

import {
  loadConfig,
  NODE_ENVS,
  zSecret,
  zSecretUrl,
  zString,
  zUrl,
  type EnvSource,
} from '@blackwing/config';

import { deriveKey, MIN_SECRET_LENGTH } from './seal.js';

const SECURE_ENVS: readonly string[] = ['staging', 'production'];

const authEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS),
    /** Realm issuer, e.g. `https://id.example.com/realms/blackwing`. */
    KEYCLOAK_ISSUER_URL: zUrl({ protocols: ['http:', 'https:'] }),
    KEYCLOAK_CLIENT_ID: zString(),
    /** Set for a confidential client (dev `bw-console-bff`); unset for the public PKCE client. */
    KEYCLOAK_CLIENT_SECRET: zSecret().optional(),
    /** The console's own origin as the browser sees it; the OIDC redirect URI is derived from it. */
    BW_CONSOLE_ORIGIN: zUrl({ protocols: ['http:', 'https:'] }),
    /** Valkey holding the server-side sessions. */
    REDIS_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }),
    /** Sealing secret (at least 32 random characters), resolved from OpenBao and injected as a secret. */
    BW_WEB_SESSION_SECRET: zSecret(),
    /** The secret being rotated out: still accepted for opening, never used for sealing. */
    BW_WEB_SESSION_SECRET_PREVIOUS: zSecret().optional(),
    /**
     * Service-account client that may end a user's Keycloak sessions (Admin API `logout`, #336). Both
     * or neither: without it a revocation still ends every BFF session, but reports Keycloak as skipped.
     */
    KEYCLOAK_SESSION_ADMIN_CLIENT_ID: zString().optional(),
    KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET: zSecret().optional(),
  })
  .superRefine((env, ctx) => {
    for (const key of ['BW_WEB_SESSION_SECRET', 'BW_WEB_SESSION_SECRET_PREVIOUS'] as const) {
      const value = env[key];
      if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `must be at least ${String(MIN_SECRET_LENGTH)} characters`,
        });
      }
    }
    if (
      (env.KEYCLOAK_SESSION_ADMIN_CLIENT_ID === undefined) !==
      (env.KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET'],
        message:
          'set KEYCLOAK_SESSION_ADMIN_CLIENT_ID and KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET together',
      });
    }
    if (!SECURE_ENVS.includes(env.NODE_ENV)) return;
    for (const key of ['KEYCLOAK_ISSUER_URL', 'BW_CONSOLE_ORIGIN'] as const) {
      if (!env[key].startsWith('https:')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must use https in this environment',
        });
      }
    }
  });

export interface AuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  /** Normalised origin (no path, no trailing slash). */
  readonly consoleOrigin: string;
  /** Registered in Keycloak as the client's redirect URI (`scripts/keycloak-realm.mjs`). */
  readonly redirectUri: string;
  readonly redisUrl: string;
  /** The sealing key first, then the previous key (rotation) accepted for opening only. */
  readonly sessionKeys: readonly [Buffer, ...Buffer[]];
  /** The Keycloak session-admin client, when configured (both values or neither). */
  readonly sessionAdmin: { readonly clientId: string; readonly clientSecret: string } | undefined;
}

/** Path Keycloak redirects back to; `next.config.mjs` rewrites it to `/api/auth/callback`. */
const CALLBACK_PATH = '/auth/callback';

/** Parses the environment; throws a `ConfigValidationError` (key names only) when it is invalid. */
export function loadAuthConfig(source: EnvSource = process.env): AuthConfig {
  const env = loadConfig(authEnvSchema, source);
  const consoleOrigin = new URL(env.BW_CONSOLE_ORIGIN).origin;
  return {
    issuer: env.KEYCLOAK_ISSUER_URL.replace(/\/+$/, ''),
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    consoleOrigin,
    redirectUri: `${consoleOrigin}${CALLBACK_PATH}`,
    redisUrl: env.REDIS_URL,
    sessionKeys: [
      deriveKey(env.BW_WEB_SESSION_SECRET),
      ...(env.BW_WEB_SESSION_SECRET_PREVIOUS === undefined
        ? []
        : [deriveKey(env.BW_WEB_SESSION_SECRET_PREVIOUS)]),
    ],
    sessionAdmin:
      env.KEYCLOAK_SESSION_ADMIN_CLIENT_ID === undefined ||
      env.KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET === undefined
        ? undefined
        : {
            clientId: env.KEYCLOAK_SESSION_ADMIN_CLIENT_ID,
            clientSecret: env.KEYCLOAK_SESSION_ADMIN_CLIENT_SECRET,
          },
  };
}
