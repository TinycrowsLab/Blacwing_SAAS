// SOC portal configuration (SOCUI-001, #553), read once through @blackwing/config. The portal is
// fail-closed: with none of its variables set it is disabled and every link is refused. A partial
// setup is a configuration error, so it fails fast instead of silently refusing every link.

import { createPublicKey, type KeyObject } from 'node:crypto';

import { z } from 'zod';

import { loadConfig, type EnvSource, zSecret, zString } from '@blackwing/config';

import { deriveKey, MIN_SECRET_LENGTH } from '../auth/seal.js';

const socPortalEnvSchema = z
  .object({
    /** `kid` of the Ed25519 key that signs portal links (the token header names it). */
    BW_SOC_LINK_KEY_ID: zString().optional(),
    /** PEM (SPKI) public key that verifies portal links. Public, so it is not a secret. */
    BW_SOC_LINK_PUBLIC_KEY: zString().optional(),
    /** Sealing secret for the scoped portal session cookie (at least 32 random characters). */
    BW_SOC_PORTAL_SESSION_SECRET: zSecret().optional(),
  })
  .superRefine((env, ctx) => {
    const keys = [
      'BW_SOC_LINK_KEY_ID',
      'BW_SOC_LINK_PUBLIC_KEY',
      'BW_SOC_PORTAL_SESSION_SECRET',
    ] as const;
    const setCount = keys.filter((key) => env[key] !== undefined).length;
    if (setCount > 0 && setCount < keys.length) {
      for (const key of keys) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'set BW_SOC_LINK_KEY_ID, BW_SOC_LINK_PUBLIC_KEY and BW_SOC_PORTAL_SESSION_SECRET together',
          });
        }
      }
    }
    const secret = env.BW_SOC_PORTAL_SESSION_SECRET;
    if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['BW_SOC_PORTAL_SESSION_SECRET'],
        message: `must be at least ${String(MIN_SECRET_LENGTH)} characters`,
      });
    }
  });

export interface SocPortalConfig {
  readonly keyId: string;
  /** The Ed25519 public key, checked to be Ed25519 at load time. */
  readonly publicKey: KeyObject;
  /** The sealing key for the portal session cookie. */
  readonly sessionKey: Buffer;
}

/**
 * The portal configuration, or `undefined` when the portal is disabled. Throws a
 * `ConfigValidationError` (key names only, never values) when it is partly set or malformed.
 */
export function loadSocPortalConfig(source: EnvSource = process.env): SocPortalConfig | undefined {
  const env = loadConfig(socPortalEnvSchema, source);
  if (
    env.BW_SOC_LINK_KEY_ID === undefined ||
    env.BW_SOC_LINK_PUBLIC_KEY === undefined ||
    env.BW_SOC_PORTAL_SESSION_SECRET === undefined
  ) {
    return undefined;
  }
  const publicKey = createPublicKey(env.BW_SOC_LINK_PUBLIC_KEY);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('BW_SOC_LINK_PUBLIC_KEY must be an Ed25519 public key');
  }
  return {
    keyId: env.BW_SOC_LINK_KEY_ID,
    publicKey,
    sessionKey: deriveKey(env.BW_SOC_PORTAL_SESSION_SECRET),
  };
}
