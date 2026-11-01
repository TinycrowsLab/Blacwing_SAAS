import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { type JwsKeyResolver, type JwsSigner, signJws } from '@blackwing/crypto';

import { deriveKey } from '../auth/seal.js';

import type { SocPortalConfig } from './config.js';

/** A link's lifetime in the fixtures: one hour. */
export const TTL_SECONDS = 3600;

/** A fixed epoch-seconds "now" for every test (2027-01-15T08:00:00Z). */
export const NOW_SECONDS = 1_800_000_000;
export const TENANT_ID = '018f3c2e-7b1a-7c3d-9a4b-0123456789a1';
export const ASSET_ID = '018f3c2e-7b1a-7c3d-9a4b-0123456789a2';
export const OTHER_ASSET_ID = '018f3c2e-7b1a-7c3d-9a4b-0123456789a3';
export const JTI = '018f3c2e-7b1a-7c3d-9a4b-0123456789a4';
export const KID = 'soc-link-test-1';

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function newKeyPair(): KeyPair {
  return generateKeyPairSync('ed25519');
}

export const testKeys: KeyPair = newKeyPair();

export const resolverFor =
  (keys: KeyPair, kid = KID): JwsKeyResolver =>
  (requested) =>
    requested === kid ? keys.publicKey : undefined;

/** A portal link payload with sensible defaults; `overrides` lets a test break one claim. */
export function linkClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    scope: 'soc_portal',
    assetIds: [ASSET_ID],
    jti: JTI,
    exp: NOW_SECONDS + TTL_SECONDS,
    ...overrides,
  };
}

/** Signs a link with `keys` under `KID`. */
export function signLink(payload: unknown, keys: KeyPair = testKeys, kid = KID): string {
  const signer: JwsSigner = { kid, privateKey: keys.privateKey };
  return signJws(payload, signer);
}

export const SESSION_SECRET = 'soc-portal-test-secret-0123456789abcdef';

/** The runtime configuration a live portal would load, built from the test key pair. */
export function portalConfig(keys: KeyPair = testKeys): SocPortalConfig {
  return {
    keyId: KID,
    publicKey: keys.publicKey,
    sessionKey: deriveKey(SESSION_SECRET),
  };
}
