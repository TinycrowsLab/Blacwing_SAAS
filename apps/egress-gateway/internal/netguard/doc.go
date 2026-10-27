// Package netguard is the gateway's single blocked-address policy (EGRESS-009, CONTEXT_PACK
// §8.2): private, loopback, link-local, CGNAT, multicast, reserved and cloud-metadata ranges are
// refused unless the exact address is explicitly included by the scope rules. The DNS resolver
// (EGRESS-008) and every dialer share this one table, so the name and direct-IP paths agree.
//
// The package depends on the standard library only, so any other internal package may import it.
// Everything fails closed: an invalid address is blocked.
package netguard
