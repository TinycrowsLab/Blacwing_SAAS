package netguard

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"syscall"
)

// Reasons reported in a Verdict, the egress_range_blocked_total{reason} label values.
const (
	ReasonMetadata = "metadata"
	ReasonRange    = "range"
	ReasonExtra    = "extra"
	ReasonInvalid  = "invalid"
)

// ErrBlocked is wrapped by every dial refused by the guard.
var ErrBlocked = errors.New("EGRESS_RANGE_BLOCKED")

// ScopeRules reports whether the scope envelope explicitly includes an address (an include rule
// whose IP/CIDR contains it, not excluded). *scope.RuleSet implements it; a nil value means
// nothing is explicitly in scope.
type ScopeRules interface {
	IPInScope(ip netip.Addr) bool
}

// Verdict is the outcome of Check. CIDR is the matched range when Blocked and Reason is not
// ReasonInvalid.
type Verdict struct {
	Blocked bool
	Reason  string
	CIDR    netip.Prefix
}

var (
	metadataPrefixes = mustPrefixes("169.254.169.254/32", "fd00:ec2::254/128")

	// defaultBlocked is CONTEXT_PACK §8.2: IPv4 private/loopback/link-local/CGNAT/"this"/multicast/
	// reserved, IPv6 loopback/unspecified/ULA/link-local/multicast, and the NAT64 local-use /48.
	// IPv4-mapped IPv6 (::ffff:0:0/96) is not listed because Check unmaps it first and re-checks
	// the IPv4 table; the well-known NAT64 /96 likewise checks its embedded IPv4.
	defaultBlocked = mustPrefixes(
		"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16",
		"100.64.0.0/10", "0.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4", "192.0.0.0/24", "198.18.0.0/15",
		"::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b:1::/48",
	)
	nat64 = netip.MustParsePrefix("64:ff9b::/96")

	shared = &Guard{prefixes: defaultBlocked}
)

func mustPrefixes(s ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(s))
	for i, p := range s {
		out[i] = netip.MustParsePrefix(p)
	}
	return out
}

// Guard is an immutable blocked-range table, safe for concurrent use.
type Guard struct {
	prefixes []netip.Prefix
	extra    []netip.Prefix
}

// Default returns the shared guard with only the built-in ranges. DNS and dialers use this (or
// a Guard built by New) so there is one table.
func Default() *Guard { return shared }

// DefaultBlocked returns a copy of the built-in blocked ranges.
func DefaultBlocked() []netip.Prefix { return append([]netip.Prefix(nil), defaultBlocked...) }

// New returns a Guard with the built-in ranges plus extra, which come from
// GATEWAY_EXTRA_BLOCKED_CIDRS (see ParseCIDRList).
func New(extra []netip.Prefix) *Guard {
	return &Guard{prefixes: defaultBlocked, extra: append([]netip.Prefix(nil), extra...)}
}

// maxExtra bounds GATEWAY_EXTRA_BLOCKED_CIDRS so a lookup stays cheap.
const maxExtra = 256

// ParseCIDRList parses a comma-separated list of CIDRs or bare addresses (strict: host bits must
// be zero; IPv4-mapped IPv6 prefixes are converted to IPv4). An empty string is an empty list.
func ParseCIDRList(s string) ([]netip.Prefix, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	items := strings.Split(s, ",")
	if len(items) > maxExtra {
		return nil, fmt.Errorf("at most %d CIDRs are allowed", maxExtra)
	}
	out := make([]netip.Prefix, 0, len(items))
	for _, it := range items {
		it = strings.TrimSpace(it)
		p, err := parseExtra(it)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q", it)
		}
		out = append(out, p)
	}
	return out, nil
}

func parseExtra(s string) (netip.Prefix, error) {
	addrText, bitsText, hasBits := strings.Cut(s, "/")
	a, err := ParseLiteral(addrText)
	if err != nil {
		return netip.Prefix{}, err
	}
	bits := a.BitLen()
	if hasBits {
		n, derr := parseDecimal(bitsText)
		if derr != nil {
			return netip.Prefix{}, derr
		}
		bits = n
		// A prefix written in IPv4-mapped form (::ffff:a.b.c.d/N) counts N from the IPv6 start.
		if a.Is4() && strings.Contains(addrText, ":") {
			bits -= 96
		}
	}
	p, err := a.Prefix(bits)
	if err != nil || p.Addr() != a {
		return netip.Prefix{}, errors.New("bad prefix")
	}
	return p, nil
}

func parseDecimal(s string) (int, error) {
	if s == "" || len(s) > 3 {
		return 0, errors.New("bad prefix length")
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("bad prefix length")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// canonical unmaps IPv4-mapped IPv6 and drops any zone.
func canonical(ip netip.Addr) netip.Addr { return ip.WithZone("").Unmap() }

// Check decides whether ip may not be dialled. An address explicitly included by scope is never
// blocked (S8.2); an invalid address is always blocked.
func (g *Guard) Check(ip netip.Addr, scope ScopeRules) Verdict {
	if !ip.IsValid() {
		return Verdict{Blocked: true, Reason: ReasonInvalid}
	}
	ip = canonical(ip)
	if scope != nil && scope.IPInScope(ip) {
		return Verdict{}
	}
	if nat64.Contains(ip) {
		b := ip.As16()
		return g.Check(netip.AddrFrom4([4]byte(b[12:])), scope)
	}
	if p, ok := first(metadataPrefixes, ip); ok {
		return Verdict{Blocked: true, Reason: ReasonMetadata, CIDR: p}
	}
	if p, ok := first(g.prefixes, ip); ok {
		return Verdict{Blocked: true, Reason: ReasonRange, CIDR: p}
	}
	if p, ok := first(g.extra, ip); ok {
		return Verdict{Blocked: true, Reason: ReasonExtra, CIDR: p}
	}
	return Verdict{}
}

// IsBlocked is Check(ip, scope).Blocked.
func (g *Guard) IsBlocked(ip netip.Addr, scope ScopeRules) bool { return g.Check(ip, scope).Blocked }

// IsBlocked checks ip against the built-in table.
func IsBlocked(ip netip.Addr, scope ScopeRules) bool { return shared.IsBlocked(ip, scope) }

func first(ps []netip.Prefix, ip netip.Addr) (netip.Prefix, bool) {
	for _, p := range ps {
		if p.Contains(ip) {
			return p, true
		}
	}
	return netip.Prefix{}, false
}

// DialControl returns a net.Dialer.Control hook that refuses to connect to a blocked address.
// Control sees the final resolved ip:port immediately before connect(2), so it covers HTTP
// forward, CONNECT upstream and SOCKS relay dials and re-checks the pinned IP (a DNS answer that
// later turns into a blocked IP is still refused). onBlock, if set, is called for audit/metrics.
func (g *Guard) DialControl(scope ScopeRules, onBlock func(ip netip.Addr, v Verdict)) func(network, address string, c syscall.RawConn) error {
	return func(_, address string, _ syscall.RawConn) error {
		ap, err := netip.ParseAddrPort(address)
		if err != nil {
			if onBlock != nil {
				onBlock(netip.Addr{}, Verdict{Blocked: true, Reason: ReasonInvalid})
			}
			return fmt.Errorf("%w: unparseable dial address", ErrBlocked)
		}
		if v := g.Check(ap.Addr(), scope); v.Blocked {
			if onBlock != nil {
				onBlock(canonical(ap.Addr()), v)
			}
			return fmt.Errorf("%w: %s", ErrBlocked, v.Reason)
		}
		return nil
	}
}
