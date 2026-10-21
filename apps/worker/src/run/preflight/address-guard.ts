import { BlockList, isIP, isIPv4 } from 'node:net';

// Addresses a target must never resolve to unless a scope rule explicitly admits them (§8.2 anti-rebinding
// pre-check): loopback, private, link-local (cloud metadata 169.254.169.254, fd00:ec2::254), CGNAT,
// unspecified, benchmarking, multicast and reserved ranges.
const V4_CIDRS = [
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
] as const;
const V6_CIDRS = ['fc00::/7', 'fe80::/10', 'ff00::/8'] as const;

const blocked = new BlockList();
for (const cidr of V4_CIDRS) {
  const [net = '', prefix = ''] = cidr.split('/');
  blocked.addSubnet(net, Number(prefix), 'ipv4');
}
for (const cidr of V6_CIDRS) {
  const [net = '', prefix = ''] = cidr.split('/');
  blocked.addSubnet(net, Number(prefix), 'ipv6');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * True when `address` is in a range a public target must not resolve to. Anything that is not a valid IP
 * literal is treated as disallowed (fail closed).
 */
export function isDisallowedAddress(address: string): boolean {
  const mapped = V4_MAPPED.exec(address);
  const candidate = mapped?.[1] ?? address;
  if (isIP(candidate) === 0) return true;
  return blocked.check(candidate, isIPv4(candidate) ? 'ipv4' : 'ipv6');
}
