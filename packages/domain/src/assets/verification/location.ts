import { ValidationError } from '@blackwing/errors';

import type { AssetType, VerificationMethod } from '@blackwing/contracts';

/**
 * Where a method's token must appear (ASSET-003). The probe for each method (ASSET-005 DNS, ASSET-006 HTTP) reads
 * exactly this location; ASSET-007 manual letters have no probe location.
 */

/** The DNS label that carries the token: `_blackwing-challenge.<host>` TXT. */
export const DNS_CHALLENGE_LABEL = '_blackwing-challenge';
/** The well-known path that carries the token over HTTPS. */
export const HTTP_CHALLENGE_PATH = '/.well-known/blackwing-verify.txt';

/** The identifier fields the location needs. */
export interface LocationIdentifier {
  readonly kind: 'host' | 'url' | 'cidr' | 'repo';
  readonly value: string;
}

/** The host an asset is verified under: the first `host` or `url` identifier. Undefined when there is none. */
export function hostOf(identifiers: readonly LocationIdentifier[]): string | undefined {
  for (const identifier of identifiers) {
    if (identifier.kind === 'host') return identifier.value;
    if (identifier.kind === 'url') return new URL(identifier.value).hostname;
  }
  return undefined;
}

/**
 * The location a challenge of `method` is probed at, or `null` when the method has none (manual letter). Throws a
 * `ValidationError` when the method needs a host and the asset has none (the detail names the rule, not the value).
 */
export function expectedLocationOf(
  method: VerificationMethod,
  identifiers: readonly LocationIdentifier[],
): string | null {
  if (method === 'manual_letter') return null;
  const host = hostOf(identifiers);
  if (host === undefined) {
    throw new ValidationError('verification method needs a host or url identifier', {
      detail: `${method} verification needs a host or url identifier on the asset.`,
    });
  }
  if (method === 'dns_txt') return `${DNS_CHALLENGE_LABEL}.${host}`;
  return `https://${host}${HTTP_CHALLENGE_PATH}`;
}

/** The asset types the HTTP-file method can prove: it reads `https://<host>/.well-known/…`, so an HTTP origin is needed. */
const HTTP_ORIGIN_ASSET_TYPES: readonly AssetType[] = ['web_app', 'api'];

/**
 * Whether `method` can prove control of an asset of `assetType` (ASSET-006). The HTTP-file method applies to web and
 * API assets only; the other methods apply to every type. A refusal is `422` and the challenge is never started.
 */
export function methodAppliesToAssetType(
  method: VerificationMethod,
  assetType: AssetType,
): boolean {
  if (method === 'http_file') return HTTP_ORIGIN_ASSET_TYPES.includes(assetType);
  return true;
}
