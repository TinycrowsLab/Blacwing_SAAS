import { createHash } from 'node:crypto';

import { InvalidSurfaceInputError } from './errors.js';
import { canonicalAddress, canonicalMethod, normaliseUrlTemplate } from './normalise.js';

/** Where a parameter lives in the request. */
export const PARAMETER_LOCATIONS = ['query', 'path', 'header', 'cookie', 'body'] as const;
export const SERVICE_PROTOS = ['tcp', 'udp'] as const;

const PORT_MAX = 65_535;

/** Joins preimage parts with `|`, escaping `|` inside a part so two tuples never collide. */
function fingerprint(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.map((p) => p.replaceAll('%', '%25').replaceAll('|', '%7C')).join('|'))
    .digest('hex');
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidSurfaceInputError(`surface ${what} is missing`);
  }
  return value.trim();
}

function id(value: unknown, what: string): string {
  return text(value, what).toLowerCase();
}

/** `sha256(assetId|canonicalHostOrIp)`. */
export function hostKey(assetId: string, address: string): string {
  return fingerprint([id(assetId, 'assetId'), canonicalAddress(address)]);
}

/** `sha256(hostKey|port|proto)`. */
export function serviceKey(hostKeyValue: string, port: number, proto: string): string {
  const p = proto.toLowerCase();
  if (!Number.isInteger(port) || port < 1 || port > PORT_MAX) {
    throw new InvalidSurfaceInputError('surface port is invalid');
  }
  if (!(SERVICE_PROTOS as readonly string[]).includes(p)) {
    throw new InvalidSurfaceInputError('surface protocol is invalid');
  }
  return fingerprint([id(hostKeyValue, 'hostKey'), String(port), p]);
}

/** `sha256(assetId|method|normalisedUrlTemplate)`. */
export function endpointKey(assetId: string, method: string, url: string): string {
  return fingerprint([id(assetId, 'assetId'), canonicalMethod(method), normaliseUrlTemplate(url)]);
}

/** `sha256(endpointKey|location|name)`; the name is case-sensitive. */
export function parameterKey(endpointKeyValue: string, location: string, name: string): string {
  const loc = location.toLowerCase();
  if (!(PARAMETER_LOCATIONS as readonly string[]).includes(loc)) {
    throw new InvalidSurfaceInputError('surface parameter location is invalid');
  }
  return fingerprint([id(endpointKeyValue, 'endpointKey'), loc, text(name, 'parameter name')]);
}

/** `sha256(hostKey|product|version?)`; an absent version hashes as the empty string. */
export function technologyKey(hostKeyValue: string, product: string, version?: string): string {
  return fingerprint([
    id(hostKeyValue, 'hostKey'),
    id(product, 'product'),
    version === undefined ? '' : id(version, 'version'),
  ]);
}

/** `sha256(assetId|roleName)`. */
export function roleKey(assetId: string, roleName: string): string {
  return fingerprint([id(assetId, 'assetId'), id(roleName, 'roleName')]);
}
