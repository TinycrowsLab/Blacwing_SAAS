import { createHash, timingSafeEqual } from 'node:crypto';

import type { VirtualKeyContext } from '@blackwing/contracts';
import type { IncomingHttpHeaders } from 'node:http';

/** Who a request authenticated as. Set from the sandbox's per-session virtual key, never from the body. */
export interface ClientPrincipal {
  readonly tenantId: string;
  /** Stable, non-secret key id for logs and audit (never the key itself). */
  readonly keyId: string;
  readonly sessionId?: string | undefined;
  /** Request context of a per-session virtual key (GATEWAY-002); absent for the dev static key. */
  readonly runId?: string | undefined;
  readonly persona?: string | undefined;
  readonly budgetContext?: VirtualKeyContext['budgetContext'] | undefined;
}

/**
 * Seam for virtual-key authentication of `POST /v1/messages`. GATEWAY-002 (#405) implements it with the
 * `virtual_keys` table; returning `undefined` rejects the request with an Anthropic-shaped 401.
 */
export interface ClientKeyVerifier {
  verify(key: string): Promise<ClientPrincipal | undefined> | ClientPrincipal | undefined;
}

const VIRTUAL_KEY_PREFIX = 'bwk_';
/** Hex characters of the key hash shown in the non-secret key id. */
const KEY_ID_HASH_CHARS = 12;
const BEARER = /^Bearer\s+(\S+)$/i;

/** The client credential the sandbox sent: `x-api-key`, else `Authorization: Bearer`. */
export function extractClientKey(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
  const authorization = headers.authorization;
  if (typeof authorization !== 'string') return undefined;
  return BEARER.exec(authorization)?.[1];
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verifies a per-session `bwk_` key (GATEWAY-002, #405) through `authenticate`, which resolves it against the
 * database (see `createVirtualKeyAuthenticator`). A refused key is `undefined`; a thrown error rejects, which
 * the server answers as a failure, so the request never reaches the provider.
 */
export function virtualKeyVerifier(
  authenticate: (key: string) => Promise<VirtualKeyContext | undefined>,
): ClientKeyVerifier {
  return {
    async verify(key) {
      const context = await authenticate(key);
      if (context === undefined) return undefined;
      return {
        tenantId: context.tenantId,
        keyId: context.virtualKeyId,
        sessionId: context.sessionId,
        runId: context.runId,
        persona: context.persona,
        budgetContext: context.budgetContext,
      };
    },
  };
}

/** Accepts a key if any verifier does, asking them in order. Used to keep the dev key alongside session keys. */
export function anyVerifier(...verifiers: readonly ClientKeyVerifier[]): ClientKeyVerifier {
  return {
    async verify(key) {
      for (const verifier of verifiers) {
        const principal = await verifier.verify(key);
        if (principal !== undefined) return principal;
      }
      return undefined;
    },
  };
}

/**
 * One dev virtual key, configured by its SHA-256 only, mapped to the dev tenant. Stands in for the
 * per-session keys of GATEWAY-002 (#405) so the dev subscription provider is never reachable without a
 * `bwk_` key; it is wired only together with that provider (BW_ENV=dev).
 */
export function staticVirtualKeyVerifier(options: {
  readonly keySha256Hex: string;
  readonly tenantId: string;
}): ClientKeyVerifier {
  const expected = Buffer.from(options.keySha256Hex, 'hex');
  return {
    verify(key) {
      if (!key.startsWith(VIRTUAL_KEY_PREFIX)) return undefined;
      const actual = sha256(key);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      return {
        tenantId: options.tenantId,
        keyId: `dev:${options.keySha256Hex.slice(0, KEY_ID_HASH_CHARS)}`,
      };
    },
  };
}
