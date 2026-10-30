import {
  type DetachedJws,
  type Ed25519Jwk,
  type EnvelopeSigningKey,
  ed25519Jwk,
  signEnvelope,
} from '@blackwing/crypto';
import { AppError } from '@blackwing/errors';

import type { OpenBaoClient } from './openbao.js';

/**
 * Standing-authorisation (SA) signing on OpenBao Transit (AUTHZ-004, #376). The private key is an
 * Ed25519 Transit key that never leaves OpenBao; this module only asks Transit to sign and reads the
 * public keys back. Every OpenBao failure surfaces as `AUTHZ_SIGNER_UNAVAILABLE` (fail closed).
 */

export const DEFAULT_SIGNING_KEY_NAME = 'bw-sa-signing';
export const DEFAULT_TRANSIT_MOUNT = 'transit';
export const DEFAULT_JWKS_TTL_S = 300;
const MAX_JWKS_TTL_S = 3600;
const SIGNING_KEY_TYPE = 'ed25519';
const ED25519_PUBLIC_KEY_BYTES = 32;
const MS_PER_S = 1000;

// The key name and mount become Transit path segments, so only a conservative alphabet passes.
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MOUNT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// Transit answers `vault:v<N>:<base64 signature>`; the version is the one that actually signed.
const TRANSIT_SIGNATURE = /^vault:v(\d+):([A-Za-z0-9+/]+={0,2})$/;

export interface SigningConfig {
  /** `AUTHZ_SIGNING_KEY_NAME`: the Transit key that signs SA envelopes. */
  readonly keyName: string;
  /** `OPENBAO_TRANSIT_MOUNT`: the Transit mount path. */
  readonly transitMount: string;
  /** `AUTHZ_JWKS_TTL_S`: how long verifiers may cache the public key set. */
  readonly jwksTtlS: number;
}

/** An unset or empty environment value means "use the default". */
const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * Reads `AUTHZ_SIGNING_KEY_NAME`, `OPENBAO_TRANSIT_MOUNT` and `AUTHZ_JWKS_TTL_S` (defaults:
 * `bw-sa-signing`, `transit`, 300). A malformed value is a configuration defect (fail closed).
 */
export function signingConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SigningConfig {
  const keyName = nonEmpty(env.AUTHZ_SIGNING_KEY_NAME) ?? DEFAULT_SIGNING_KEY_NAME;
  const transitMount = nonEmpty(env.OPENBAO_TRANSIT_MOUNT) ?? DEFAULT_TRANSIT_MOUNT;
  const jwksTtlS =
    env.AUTHZ_JWKS_TTL_S === undefined || env.AUTHZ_JWKS_TTL_S === ''
      ? DEFAULT_JWKS_TTL_S
      : Number(env.AUTHZ_JWKS_TTL_S);
  if (
    !KEY_NAME.test(keyName) ||
    !MOUNT.test(transitMount) ||
    !Number.isInteger(jwksTtlS) ||
    jwksTtlS < 1 ||
    jwksTtlS > MAX_JWKS_TTL_S
  ) {
    throw new AppError(
      'CONFIG_INVALID',
      'AUTHZ_SIGNING_KEY_NAME, OPENBAO_TRANSIT_MOUNT or AUTHZ_JWKS_TTL_S is invalid',
    );
  }
  return { keyName, transitMount, jwksTtlS };
}

/** A signed envelope: what the SA row stores as `signature`, `signing_key_id` and the envelope hash. */
export interface SignedEnvelope {
  /** Compact detached JWS over the canonical body. */
  readonly signature: string;
  /** `<keyName>:v<N>`: the Transit version that signed. */
  readonly signingKeyId: string;
  readonly envelopeHash: string;
  readonly iat: number;
}

export type SigningAuditEvent =
  | {
      readonly tenantId: string;
      readonly action: 'authz.sa.signed';
      readonly metadata: {
        readonly sa_id: string;
        readonly signing_key_id: string;
        readonly envelope_hash: string;
      };
    }
  | {
      readonly tenantId: string;
      readonly action: 'authz.signing_key.rotated';
      readonly metadata: { readonly key_name: string; readonly version: number };
    };

export interface SigningMetrics {
  /** `authz_sign_total{result}` */
  sign(result: 'ok' | 'error'): void;
  /** `authz_jwks_cache_refresh_total` */
  jwksCacheRefresh(): void;
}

export interface SigningKeyServiceDeps {
  readonly client: OpenBaoClient;
  /** Required: a signature or rotation that cannot be audited must not be released. */
  readonly audit: (event: SigningAuditEvent) => Promise<void>;
  readonly metrics?: SigningMetrics;
  readonly config?: Partial<SigningConfig>;
  /** Epoch milliseconds; defaults to `Date.now`. Drives `iat` and the JWKS cache TTL. */
  readonly now?: () => number;
}

export interface SigningKeyService {
  /**
   * Signs the canonical SA body with the Transit version that is current when the call starts, and
   * records the audit event. Nothing is persisted here: the approval flow (AUTHZ-008) owns the SA state.
   */
  signEnvelope(input: {
    readonly tenantId: string;
    readonly saId: string;
    readonly canonicalBytes: Uint8Array;
  }): Promise<SignedEnvelope>;
  /**
   * Rotates the signing key to a new Transit version. New signatures use it; existing SAs keep their
   * `signing_key_id`. `tenantId` is the tenant of the operator who rotated, for the audit trail.
   */
  rotateSigningKey(
    tenantId: string,
  ): Promise<{ readonly keyName: string; readonly latestVersion: number }>;
  /**
   * The verification key set (JWK Set). Every Transit version still held is returned: versions are
   * never trimmed, so a deprecated version keeps verifying the SAs signed with it.
   */
  getPublicJwks(): Promise<{ readonly keys: readonly Ed25519Jwk[] }>;
  /**
   * The signing key pinned to the Transit version current at the call, for signing other canonical
   * envelopes (run envelopes, #399). Only signatures leave OpenBao; the private key never does.
   */
  envelopeSigningKey(): Promise<EnvelopeSigningKey>;
}

interface KeyState {
  readonly latestVersion: number;
  readonly publicKeys: ReadonlyMap<number, Uint8Array>;
}

const noopMetrics: SigningMetrics = { sign: () => undefined, jwksCacheRefresh: () => undefined };

export function createSigningKeyService(deps: SigningKeyServiceDeps): SigningKeyService {
  const { client, audit } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now ?? Date.now;
  const config: SigningConfig = {
    keyName: DEFAULT_SIGNING_KEY_NAME,
    transitMount: DEFAULT_TRANSIT_MOUNT,
    jwksTtlS: DEFAULT_JWKS_TTL_S,
    ...deps.config,
  };
  const keyPath = `${config.transitMount}/keys/${config.keyName}`;
  let jwks: { readonly keys: readonly Ed25519Jwk[]; readonly expiresAt: number } | undefined;

  /** Every OpenBao failure, including a 403 or a sealed server, fails closed with one stable code. */
  async function openBao<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (cause) {
      throw new AppError('AUTHZ_SIGNER_UNAVAILABLE', 'the signing key service is unavailable', {
        cause,
        detail: 'The signer is unavailable; nothing was signed.',
      });
    }
  }

  async function readKey(): Promise<KeyState> {
    const res = await openBao(() => client.request('GET', keyPath));
    const d = res.data;
    if (d === undefined) {
      throw new AppError(
        'AUTHZ_SIGNER_UNAVAILABLE',
        `signing key ${config.keyName} does not exist`,
      );
    }
    // A key that is exportable or of another type was not made for signing: never use it.
    if (d.type !== SIGNING_KEY_TYPE || d.exportable === true) {
      throw new AppError(
        'INTERNAL',
        `Transit key ${config.keyName} violates the signing invariants`,
      );
    }
    const latestVersion = Number(d.latest_version);
    if (!Number.isInteger(latestVersion) || latestVersion < 1) {
      throw new AppError('INTERNAL', `Transit key ${config.keyName} returned no version`);
    }
    const keys = d.keys;
    if (typeof keys !== 'object' || keys === null) {
      throw new AppError('INTERNAL', `Transit key ${config.keyName} returned no public keys`);
    }
    const publicKeys = new Map<number, Uint8Array>();
    for (const [version, entry] of Object.entries(keys)) {
      const publicKey = (entry as { readonly public_key?: unknown } | null)?.public_key;
      const raw = typeof publicKey === 'string' ? Buffer.from(publicKey, 'base64') : undefined;
      if (raw?.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
        throw new AppError('INTERNAL', `Transit key ${config.keyName} has a malformed public key`);
      }
      publicKeys.set(Number(version), new Uint8Array(raw));
    }
    if (!publicKeys.has(latestVersion)) {
      throw new AppError('INTERNAL', `Transit key ${config.keyName} has no latest public key`);
    }
    return { latestVersion, publicKeys };
  }

  /** Signs with exactly `version`, the one named in the protected header; refuses any other version. */
  async function transitSign(version: number, signingInput: Uint8Array): Promise<Uint8Array> {
    const res = await openBao(() =>
      client.request('POST', `${config.transitMount}/sign/${config.keyName}`, {
        input: Buffer.from(signingInput).toString('base64'),
        key_version: version,
      }),
    );
    const signature = res.data?.signature;
    const match = typeof signature === 'string' ? TRANSIT_SIGNATURE.exec(signature) : null;
    if (match?.[1] === undefined || match[2] === undefined || Number(match[1]) !== version) {
      throw new AppError(
        'AUTHZ_SIGNER_UNAVAILABLE',
        'the signer returned no signature for the key version',
      );
    }
    return new Uint8Array(Buffer.from(match[2], 'base64'));
  }

  /** The version is read once and pinned in both the header and the sign request, so a rotation cannot split them. */
  function pinnedKey(state: KeyState): EnvelopeSigningKey {
    return {
      kid: `${config.keyName}:v${state.latestVersion}`,
      sign: (signingInput) => transitSign(state.latestVersion, signingInput),
    };
  }

  return {
    async signEnvelope({ tenantId, saId, canonicalBytes }) {
      try {
        const key = pinnedKey(await readKey());
        const signed: DetachedJws = await signEnvelope(
          canonicalBytes,
          key,
          Math.floor(now() / MS_PER_S),
        );
        await audit({
          tenantId,
          action: 'authz.sa.signed',
          metadata: {
            sa_id: saId,
            signing_key_id: signed.kid,
            envelope_hash: signed.envelopeHash,
          },
        });
        metrics.sign('ok');
        return {
          signature: signed.compact,
          signingKeyId: signed.kid,
          envelopeHash: signed.envelopeHash,
          iat: signed.iat,
        };
      } catch (error) {
        metrics.sign('error');
        throw error;
      }
    },

    async rotateSigningKey(tenantId) {
      await readKey();
      await openBao(() => client.request('POST', `${keyPath}/rotate`));
      const state = await readKey();
      // The cached key set predates the new version, so drop it: verifiers must see the new key.
      jwks = undefined;
      await audit({
        tenantId,
        action: 'authz.signing_key.rotated',
        metadata: { key_name: config.keyName, version: state.latestVersion },
      });
      return { keyName: config.keyName, latestVersion: state.latestVersion };
    },

    async getPublicJwks() {
      const t = now();
      if (jwks !== undefined && t < jwks.expiresAt) return { keys: jwks.keys };
      const state = await readKey();
      metrics.jwksCacheRefresh();
      const keys = [...state.publicKeys.entries()]
        .sort(([a], [b]) => a - b)
        .map(([version, publicKey]) => ed25519Jwk(`${config.keyName}:v${version}`, publicKey));
      jwks = { keys, expiresAt: t + config.jwksTtlS * MS_PER_S };
      return { keys };
    },

    async envelopeSigningKey() {
      return pinnedKey(await readKey());
    },
  };
}
