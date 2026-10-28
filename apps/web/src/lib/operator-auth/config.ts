// Platform-operator BFF configuration (#838), read once through @blackwing/config (fail fast, secrets registered for
// redaction). Operators sign in against their own realm (`blackwing-operators`) with their own confidential client
// (`operator-bff`), and seal their cookie with their own key, so nothing about a tenant session can open here.
// Staging and production require https for the issuer and the console origin; the cookies are `Secure` everywhere.

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

import { deriveKey, MIN_SECRET_LENGTH } from '../auth/seal.js';

const SECURE_ENVS: readonly string[] = ['staging', 'production'];

/** The redirect URI the operator client is registered with (`infra/keycloak/realm-blackwing-operators.json`). */
const OPERATOR_CALLBACK_PATH = '/operator/api/auth/callback';

const operatorAuthEnvSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS),
    /** Operator realm issuer, e.g. `https://id.example.com/realms/blackwing-operators`. */
    OPERATOR_KEYCLOAK_ISSUER_URL: zUrl({ protocols: ['http:', 'https:'] }),
    /** The confidential operator client (`operator-bff`). */
    OPERATOR_KEYCLOAK_CLIENT_ID: zString(),
    OPERATOR_KEYCLOAK_CLIENT_SECRET: zSecret(),
    /** The console's own origin as the browser sees it; the OIDC redirect URI is derived from it. */
    BW_CONSOLE_ORIGIN: zUrl({ protocols: ['http:', 'https:'] }),
    /** Valkey holding the operator sessions (`op_session:` keyspace). */
    REDIS_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }),
    /** Sealing secret for operator cookies and records: separate from the tenant secret (#838). */
    BW_OPERATOR_SESSION_SECRET: zSecret(),
    /** The secret being rotated out: still accepted for opening, never used for sealing. */
    BW_OPERATOR_SESSION_SECRET_PREVIOUS: zSecret().optional(),
  })
  .superRefine((env, ctx) => {
    for (const key of [
      'BW_OPERATOR_SESSION_SECRET',
      'BW_OPERATOR_SESSION_SECRET_PREVIOUS',
    ] as const) {
      const value = env[key];
      if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `must be at least ${String(MIN_SECRET_LENGTH)} characters`,
        });
      }
    }
    if (!SECURE_ENVS.includes(env.NODE_ENV)) return;
    for (const key of ['OPERATOR_KEYCLOAK_ISSUER_URL', 'BW_CONSOLE_ORIGIN'] as const) {
      if (!env[key].startsWith('https:')) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must use https in this environment',
        });
      }
    }
  });

export interface OperatorAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Normalised origin (no path, no trailing slash). */
  readonly consoleOrigin: string;
  readonly redirectUri: string;
  readonly redisUrl: string;
  /** The sealing key first, then the previous key (rotation) accepted for opening only. */
  readonly sessionKeys: readonly [Buffer, ...Buffer[]];
}

/** Parses the operator environment; throws a `ConfigValidationError` (key names only) when it is invalid. */
export function loadOperatorAuthConfig(source: EnvSource = process.env): OperatorAuthConfig {
  const env = loadConfig(operatorAuthEnvSchema, source);
  const consoleOrigin = new URL(env.BW_CONSOLE_ORIGIN).origin;
  return {
    issuer: env.OPERATOR_KEYCLOAK_ISSUER_URL.replace(/\/+$/, ''),
    clientId: env.OPERATOR_KEYCLOAK_CLIENT_ID,
    clientSecret: env.OPERATOR_KEYCLOAK_CLIENT_SECRET,
    consoleOrigin,
    redirectUri: `${consoleOrigin}${OPERATOR_CALLBACK_PATH}`,
    redisUrl: env.REDIS_URL,
    sessionKeys: [
      deriveKey(env.BW_OPERATOR_SESSION_SECRET),
      ...(env.BW_OPERATOR_SESSION_SECRET_PREVIOUS === undefined
        ? []
        : [deriveKey(env.BW_OPERATOR_SESSION_SECRET_PREVIOUS)]),
    ],
  };
}
