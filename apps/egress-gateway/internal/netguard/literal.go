package netguard

import (
	"errors"
	"net/netip"
	"strconv"
	"strings"
)

var (
	// ErrNotLiteral means the text is clearly a hostname, not an IP literal.
	ErrNotLiteral = errors.New("not an ip literal")
	// ErrInvalidLiteral means the text looks like an IP literal but is malformed or ambiguous.
	// Callers must treat it as out of scope: a resolver library could read it as an address.
	ErrInvalidLiteral = errors.New("invalid ip literal")
)

const maxZoneLen = 15

// ParseLiteral normalises an IP literal to a canonical netip.Addr: IPv4-mapped IPv6 is unmapped
// and IPv6 zone IDs are validated then dropped. IPv4 accepts the inet_aton forms a system resolver
// would accept (decimal 2130706433, octal 0177.0.0.1, hex 0x7f.1, short 127.1) which are the
// classic SSRF bypasses. A surrounding [] pair (URL host form) is tolerated.
func ParseLiteral(s string) (netip.Addr, error) {
	if len(s) >= 2 && s[0] == '[' && s[len(s)-1] == ']' {
		s = s[1 : len(s)-1]
	} else if strings.ContainsAny(s, "[]") {
		return netip.Addr{}, ErrInvalidLiteral
	}
	if strings.Contains(s, ":") {
		return parseV6(s)
	}
	s = strings.TrimSuffix(s, ".")
	last := s[strings.LastIndexByte(s, '.')+1:]
	if last == "" || last[0] < '0' || last[0] > '9' {
		return netip.Addr{}, ErrNotLiteral
	}
	return parseV4(s)
}

func parseV6(s string) (netip.Addr, error) {
	if i := strings.IndexByte(s, '%'); i >= 0 {
		zone := s[i+1:]
		if zone == "" || len(zone) > maxZoneLen || strings.IndexFunc(zone, notZoneRune) >= 0 {
			return netip.Addr{}, ErrInvalidLiteral
		}
		s = s[:i]
	}
	a, err := netip.ParseAddr(s)
	if err != nil || !a.Is6() {
		return netip.Addr{}, ErrInvalidLiteral
	}
	return a.Unmap(), nil
}

func notZoneRune(r rune) bool {
	return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.'
}

// parseV4 follows inet_aton: 1-4 dot-separated numbers (0x hex, leading-0 octal, else decimal),
// the last one filling the remaining bytes.
func parseV4(s string) (netip.Addr, error) {
	parts := strings.Split(s, ".")
	if len(parts) > 4 {
		return netip.Addr{}, ErrInvalidLiteral
	}
	var v uint64
	for i, p := range parts {
		n, ok := parseNumber(p)
		if !ok {
			return netip.Addr{}, ErrInvalidLiteral
		}
		if i < len(parts)-1 {
			if n > 255 {
				return netip.Addr{}, ErrInvalidLiteral
			}
			v |= n << (8 * (3 - uint(i)))
			continue
		}
		if n >= 1<<(8*(5-uint(len(parts)))) {
			return netip.Addr{}, ErrInvalidLiteral
		}
		v |= n
	}
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}), nil
}

func parseNumber(p string) (uint64, bool) {
	base := 10
	switch {
	case len(p) > 2 && (p[:2] == "0x" || p[:2] == "0X"):
		base, p = 16, p[2:]
	case len(p) > 1 && p[0] == '0':
		base, p = 8, p[1:]
	}
	if p == "" || p[0] == '+' || p[0] == '-' {
		return 0, false
	}
	n, err := strconv.ParseUint(p, base, 32)
	return n, err == nil
}
