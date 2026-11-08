// DEMO-STORY target allow/deny rules: which origins Blackwing may test at all. Pure classification plus one DNS
// lookup. The console and the API themselves, cloud metadata and link-local addresses are never testable; private
// and local addresses only when the operator listed the origin in BW_LAB_ORIGINS.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4 } from 'node:net';

/** Where an origin points: Blackwing itself, a never-testable address, a private/local one, or the internet. */
export type OriginClass = 'platform' | 'forbidden' | 'private' | 'public' | 'unresolved';

export interface OriginPolicy {
  /** Normalised origins the operator listed as labs (BW_LAB_ORIGINS). */
  readonly labOrigins: readonly string[];
  /** Normalised origins of the console and the API. */
  readonly platformOrigins: readonly string[];
  /** Ports of the console, the API and the smoke API: a loopback host on one of them is Blackwing itself. */
  readonly platformPorts: readonly number[];
}

/** Resolves a host name to its addresses (an IP literal resolves to itself). */
export type Lookup = (host: string) => Promise<readonly string[]>;

export const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Cloud metadata endpoints by name or fixed address. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function blockList(v4: readonly string[], v6: readonly string[], addresses: readonly string[]): BlockList {
  const list = new BlockList();
  for (const [cidrs, family] of [
    [v4, 'ipv4'],
    [v6, 'ipv6'],
  ] as const) {
    for (const cidr of cidrs) {
      const [net = '', prefix = ''] = cidr.split('/');
      list.addSubnet(net, Number(prefix), family);
    }
  }
  for (const address of addresses) list.addAddress(address, 'ipv6');
  return list;
}

/** Link-local (cloud metadata 169.254.169.254) and unspecified addresses: never testable. */
const FORBIDDEN = blockList(['169.254.0.0/16', '0.0.0.0/8'], ['fe80::/10'], ['::']);

/** Same ranges as apps/worker/src/run/preflight/address-guard.ts (copied: apps never import each other). */
const PRIVATE = blockList(
  [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ],
  ['fc00::/7', 'fe80::/10', 'ff00::/8'],
  ['::', '::1'],
);

const LOOPBACK = blockList(['127.0.0.0/8', '0.0.0.0/8'], [], ['::', '::1']);

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True when `address` (an IP literal) is in `list`; anything that is not an IP literal counts as inside. */
function inList(list: BlockList, address: string): boolean {
  const candidate = V4_MAPPED.exec(address)?.[1] ?? address;
  if (isIP(candidate) === 0) return true;
  return list.check(candidate, isIPv4(candidate) ? 'ipv4' : 'ipv6');
}

/** `scheme://host[:port]`, or null when the value is not an http(s) URL. */
export function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

const HTTP_PORT = 80;
const HTTPS_PORT = 443;

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
/** The port an http(s) URL connects to (the scheme's default when none is written). */
export const portOf = (url: URL): number =>
  url.port === '' ? (url.protocol === 'https:' ? HTTPS_PORT : HTTP_PORT) : Number(url.port);

/** The checks that need no DNS: Blackwing's own origins and metadata or link-local literals. */
export function staticClass(origin: string, policy: OriginPolicy): 'platform' | 'forbidden' | null {
  const url = new URL(origin);
  const host = hostOf(url);
  if (policy.platformOrigins.includes(url.origin)) return 'platform';
  if (METADATA_HOSTS.has(host) || (isIP(host) !== 0 && inList(FORBIDDEN, host))) return 'forbidden';
  const loopbackName = host === 'localhost' || host.endsWith('.localhost');
  if ((loopbackName || (isIP(host) !== 0 && inList(LOOPBACK, host))) && policy.platformPorts.includes(portOf(url))) {
    return 'platform';
  }
  return null;
}

export const isLabOrigin = (origin: string, policy: OriginPolicy): boolean =>
  policy.labOrigins.includes(new URL(origin).origin);

/** Classifies one origin: the static rules first, then every address its host resolves to. */
export async function classifyOrigin(origin: string, policy: OriginPolicy, lookup: Lookup): Promise<OriginClass> {
  const fixed = staticClass(origin, policy);
  if (fixed !== null) return fixed;
  const url = new URL(origin);
  let addresses: readonly string[];
  try {
    addresses = await lookup(hostOf(url));
  } catch {
    return 'unresolved';
  }
  if (addresses.length === 0) return 'unresolved';
  if (addresses.some((a) => METADATA_HOSTS.has(a.toLowerCase()) || inList(FORBIDDEN, a))) return 'forbidden';
  if (addresses.some((a) => inList(LOOPBACK, a)) && policy.platformPorts.includes(portOf(url))) return 'platform';
  if (addresses.some((a) => inList(PRIVATE, a))) return 'private';
  return 'public';
}

/** Plain-words refusal for an origin Blackwing may not test, or null when it may. */
export function refusalFor(origin: string, kind: OriginClass, policy: OriginPolicy): string | null {
  switch (kind) {
    case 'public':
      return null;
    case 'private':
      return isLabOrigin(origin, policy)
        ? null
        : `${origin} is a private or local address. It can be tested only when your Blackwing operator has listed it as a lab.`;
    case 'platform':
      return 'Blackwing cannot test its own console or API.';
    case 'forbidden':
      return 'Cloud metadata and link-local addresses can never be tested.';
    case 'unresolved':
      return `Blackwing could not resolve ${new URL(origin).host}. Check the address and try again.`;
  }
}

/** The first refusal among `origins` (in order), or null when every one may be tested. */
export async function firstRefusal(
  origins: readonly string[],
  policy: OriginPolicy,
  lookup: Lookup,
): Promise<string | null> {
  const kinds = await Promise.all(origins.map((o) => classifyOrigin(o, policy, lookup)));
  for (const [index, origin] of origins.entries()) {
    const refusal = refusalFor(origin, kinds[index] ?? 'unresolved', policy);
    if (refusal !== null) return refusal;
  }
  return null;
}
