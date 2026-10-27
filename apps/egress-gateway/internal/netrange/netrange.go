// Package netrange holds the destination ranges the egress gateway never connects
// to unless the run's envelope scope names that exact IP or CIDR (CONTEXT_PACK
// §8.2). It is the single blocked-range table shared by the scoped DNS resolver
// and the HTTP/SOCKS dialers, so every data-plane component applies one list.
package netrange

import "net/netip"

// blocked lists the non-public ranges: loopback, private, link-local (which
// contains the 169.254.169.254 metadata address), CGNAT, multicast and the other
// IANA special-purpose blocks. fd00:ec2::254 (AWS IPv6 metadata) falls in fc00::/7.
var blocked = mustPrefixes(
	"0.0.0.0/8",      // "this network"
	"10.0.0.0/8",     // private
	"100.64.0.0/10",  // CGNAT
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local, includes the 169.254.169.254 metadata endpoint
	"172.16.0.0/12",  // private
	"192.0.0.0/24",   // IETF protocol assignments
	"192.168.0.0/16", // private
	"198.18.0.0/15",  // benchmarking
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reserved, includes broadcast
	"::/128",         // unspecified
	"::1/128",        // loopback
	"64:ff9b::/96",   // NAT64: can embed a private IPv4 destination
	"fc00::/7",       // unique local, includes fd00:ec2::254 metadata
	"fe80::/10",      // link-local
	"ff00::/8",       // multicast
)

func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(cidrs))
	for i, c := range cidrs {
		out[i] = netip.MustParsePrefix(c)
	}
	return out
}

// IsBlocked reports whether ip lies in a blocked range. IPv4-mapped IPv6 addresses
// are unmapped first so ::ffff:10.0.0.1 cannot bypass the IPv4 entries. An invalid
// address is blocked (fail closed).
func IsBlocked(ip netip.Addr) bool {
	if !ip.IsValid() {
		return true
	}
	ip = ip.Unmap().WithZone("")
	for _, p := range blocked {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
