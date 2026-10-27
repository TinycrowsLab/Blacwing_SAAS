import { type Cidr, cidrContains, parseCidr, parseIp } from '@blackwing/contracts';

/**
 * Loopback, private, link-local (cloud metadata included), CGNAT, multicast, reserved and address-embedding
 * ranges. An answer inside one is never scanned unless an explicit CIDR include puts it in scope (§8.2).
 * IPv4 entries also cover IPv4-mapped IPv6 because `parseIp` maps IPv4 into that space.
 */
const NON_PUBLIC: readonly Cidr[] = [
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
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((text) => {
  const cidr = parseCidr(text);
  if (cidr === null) throw new TypeError(`invalid built-in CIDR ${text}`);
  return cidr;
});

/** True for a malformed address or one inside a non-public range (fail closed). */
export function isNonPublicIp(ip: string): boolean {
  const value = parseIp(ip);
  return value === null || NON_PUBLIC.some((cidr) => cidrContains(cidr, value));
}
