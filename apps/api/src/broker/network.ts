import { BlockList, isIP } from 'node:net';

/**
 * Source restriction of the Run Broker (API-014 requirement 3). NetworkPolicy (INFRA) is the primary
 * control; this is defence in depth and fails closed.
 *
 * A request is accepted only if BOTH hold:
 *  1. the socket peer address is inside `BROKER_ALLOWED_CIDRS`. `X-Forwarded-For` is never consulted:
 *     any client can forge it;
 *  2. the mesh/ingress identity header (set by the mesh, stripped from inbound traffic at the edge)
 *     carries one of the configured identities.
 * A missing address, an unparseable address, an empty allowlist or a missing header all refuse.
 */
export interface SourcePolicy {
  /** Allowed CIDRs (`10.20.0.0/16`, `fd00::/8`) or single addresses. */
  readonly allowedCidrs: readonly string[];
  /** Name of the header the mesh sets. */
  readonly identityHeader: string;
  /** Accepted values of that header. */
  readonly identities: readonly string[];
}

export type SourceRefusal =
  'no_policy' | 'no_address' | 'bad_address' | 'cidr_mismatch' | 'identity_mismatch';

export class InvalidCidrError extends Error {
  constructor(entry: string) {
    super(`invalid CIDR or address in BROKER_ALLOWED_CIDRS: ${entry}`);
    this.name = 'InvalidCidrError';
  }
}

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4 = 4;
const IPV4_BITS = 32;
const IPV6_BITS = 128;

/** Normalises `::ffff:10.0.0.1` to `10.0.0.1` so one allowlist entry covers both spellings. */
function normaliseAddress(address: string): string {
  const withoutZone = address.split('%', 1)[0] ?? address;
  const mapped = V4_MAPPED.exec(withoutZone);
  return mapped?.[1] ?? withoutZone;
}

function addCidr(list: BlockList, entry: string): void {
  const [address, prefix, ...rest] = entry.split('/');
  const family = address === undefined ? 0 : isIP(address);
  if (address === undefined || family === 0 || rest.length > 0) throw new InvalidCidrError(entry);
  const type = family === IPV4 ? 'ipv4' : 'ipv6';
  if (prefix === undefined) {
    list.addAddress(address, type);
    return;
  }
  const bits = Number(prefix);
  const max = family === IPV4 ? IPV4_BITS : IPV6_BITS;
  if (!/^\d{1,3}$/.test(prefix) || bits > max) throw new InvalidCidrError(entry);
  list.addSubnet(address, bits, type);
}

export interface SourceGuard {
  /** Returns `null` when the request may proceed, otherwise why it was refused. */
  check(input: {
    readonly remoteAddress: string | undefined;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  }): SourceRefusal | null;
}

/** Builds the guard; throws {@link InvalidCidrError} on a malformed allowlist so the process refuses to start. */
export function createSourceGuard(policy: SourcePolicy): SourceGuard {
  const list = new BlockList();
  for (const entry of policy.allowedCidrs) addCidr(list, entry.trim());
  const header = policy.identityHeader.toLowerCase();
  const identities = new Set(policy.identities);
  const configured = policy.allowedCidrs.length > 0 && identities.size > 0;
  return {
    check({ remoteAddress, headers }) {
      if (!configured) return 'no_policy';
      if (remoteAddress === undefined || remoteAddress === '') return 'no_address';
      const address = normaliseAddress(remoteAddress);
      const family = isIP(address);
      if (family === 0) return 'bad_address';
      if (!list.check(address, family === IPV4 ? 'ipv4' : 'ipv6')) return 'cidr_mismatch';
      const value = headers[header];
      if (typeof value !== 'string' || !identities.has(value)) return 'identity_mismatch';
      return null;
    },
  };
}
