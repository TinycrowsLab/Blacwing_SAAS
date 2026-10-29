import { isIP } from 'node:net';

import {
  ASSET_TYPE_IDENTIFIER_KIND,
  type AssetIdentifierInput,
  type AssetIdentifier,
  type AssetType,
} from '@blackwing/contracts';

import { AssetInvalidIdentifierError } from './errors.js';

/**
 * Identifier normalisation for registration (ASSET-002). Each identifier is reduced to one canonical value so
 * the same target registered twice compares equal. A rule failure is `ASSET_INVALID_IDENTIFIER` (422).
 * Credentials never survive: a URL with userinfo is refused, so a secret is never stored as an identifier.
 * The full per-kind rule set belongs to ASSET-003; this module covers the rules registration depends on.
 */

/** Normalised identifiers plus the non-fatal notices the caller shows. */
export interface NormalisedIdentifiers {
  readonly identifiers: AssetIdentifier[];
  readonly warnings: string[];
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_MAX = 253;
const IPV4_BITS = 32;
const IPV6_FAMILY = 6;
const IPV6_BITS = 128;
const IPV4_MASK_ALL = 0xffffffff;
const IPV4_FAMILY = 4;
const OCTET_BASE = 256;
const OCTET_BYTE_MASK = 0xff;
const OCTET_BITS = 8;
const OCTET_SHIFTS = Array.from(
  { length: IPV4_FAMILY },
  (_, index) => (IPV4_FAMILY - 1 - index) * OCTET_BITS,
);
const PREFIX_MIN = 0;
const TRAILING_DOT = /\.$/;
const TRAILING_SLASH = /\/$/;
const GIT_SUFFIX = /\.git$/;

function invalid(index: number, reason: string): never {
  throw new AssetInvalidIdentifierError(index, reason);
}

/** A DNS hostname or an IP literal, lowercase, without a trailing dot. */
function normaliseHost(raw: string, index: number): string {
  const host = raw.toLowerCase().replace(TRAILING_DOT, '');
  if (isIP(host) !== 0) return host;
  if (host.length > HOSTNAME_MAX) invalid(index, 'hostname is longer than 253 characters');
  if (!host.split('.').every((label) => HOST_LABEL.test(label)))
    invalid(index, 'expected a DNS hostname or an IP address');
  return host;
}

function parseUrl(raw: string, index: number, schemes: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid(index, 'expected an absolute URL');
  }
  if (!schemes.includes(url.protocol)) invalid(index, `scheme must be ${schemes.join(' or ')}`);
  if (url.username !== '' || url.password !== '')
    invalid(index, 'a URL must not embed credentials');
  if (url.hostname === '') invalid(index, 'URL has no host');
  // The fragment is client-side only; it never names a different target.
  url.hash = '';
  return url;
}

function normaliseUrl(raw: string, index: number): string {
  return parseUrl(raw, index, ['http:', 'https:']).href;
}

function normaliseRepo(raw: string, index: number): string {
  const url = parseUrl(raw, index, ['https:']);
  url.search = '';
  url.pathname = url.pathname.replace(TRAILING_SLASH, '').replace(GIT_SUFFIX, '');
  if (url.pathname === '' || url.pathname === '/')
    invalid(index, 'repository URL must name a path');
  return url.href;
}

/** `address/prefix`. IPv4 host bits are masked to the network address; IPv6 keeps its compressed form. */
function normaliseCidr(raw: string, index: number): string {
  const parts = raw.split('/');
  if (parts.length !== 2) invalid(index, 'expected CIDR notation address/prefix');
  const [address = '', prefixText = ''] = parts;
  const family = isIP(address);
  if (family === 0) invalid(index, 'CIDR address is not an IP address');
  const bits = family === IPV4_FAMILY ? IPV4_BITS : IPV6_BITS;
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > bits)
    invalid(index, `CIDR prefix must be between 0 and ${String(bits)}`);
  const prefix = Number(prefixText);
  if (family === IPV6_FAMILY) {
    return `${new URL(`http://[${address}]`).hostname.slice(1, -1)}/${String(prefix)}`;
  }
  const value = address.split('.').reduce((acc, octet) => acc * OCTET_BASE + Number(octet), 0);
  const mask = prefix === PREFIX_MIN ? 0 : (IPV4_MASK_ALL << (IPV4_BITS - prefix)) >>> 0;
  const network = (value & mask) >>> 0;
  const quad = OCTET_SHIFTS.map((shift) => (network >>> shift) & OCTET_BYTE_MASK).join('.');
  return `${quad}/${String(prefix)}`;
}

function normaliseValue(kind: AssetIdentifier['kind'], raw: string, index: number): string {
  switch (kind) {
    case 'host':
      return normaliseHost(raw, index);
    case 'url':
      return normaliseUrl(raw, index);
    case 'cidr':
      return normaliseCidr(raw, index);
    case 'repo':
      return normaliseRepo(raw, index);
  }
}

/**
 * Normalises the identifiers of one asset. Each identifier's kind must be the one its asset type covers
 * (`ASSET_TYPE_IDENTIFIER_KIND`). Duplicates after normalisation are dropped (first occurrence kept, order
 * kept) and reported as a warning, not an error.
 */
export function normaliseIdentifiers(
  type: AssetType,
  raw: readonly AssetIdentifierInput[],
): NormalisedIdentifiers {
  const expected = ASSET_TYPE_IDENTIFIER_KIND[type];
  const seen = new Set<string>();
  const identifiers: AssetIdentifier[] = [];
  raw.forEach((entry, index) => {
    if (entry.kind !== expected) invalid(index, `kind must be ${expected} for a ${type} asset`);
    const identifier: AssetIdentifier = {
      kind: entry.kind,
      value: normaliseValue(entry.kind, entry.value, index),
    };
    const key = `${identifier.kind}:${identifier.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    identifiers.push(identifier);
  });
  const removed = raw.length - identifiers.length;
  return {
    identifiers,
    warnings:
      removed === 0
        ? []
        : [`${String(removed)} duplicate identifier(s) removed after normalisation`],
  };
}
