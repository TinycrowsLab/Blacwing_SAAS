// Package scope is the deterministic scope matcher the egress gateway consults before any
// target traffic leaves (CONTEXT_PACK §8.2, §8.11; EGRESS-004). It decides whether a concrete
// target (host or IP, port, path, method) is inside an ordered include/exclude rule set.
//
// It is the Go mirror of the TypeScript matcher (`matchScope` in @blackwing/domain) and of the
// rule model in @blackwing/contracts (scope.ts). Both run the shared vectors in
// packages/contracts/src/scope.vectors.json and must agree on every one. The canonical forms
// (host: lowercase + IDNA + one trailing dot removed; IP: IPv4 held as IPv4-mapped IPv6; path:
// decoded exactly once, dot segments resolved, no trailing slash; method: upper-case) are
// documented in scope.ts and implemented here by normalise.go.
//
// Semantics, in short: default deny; every dimension a rule sets must match; of all matching
// rules the most specific wins and exclude beats include on a tie; a host rule never authorises
// the IPs a name resolves to (anti-rebinding: the gateway re-checks the pinned IP itself).
// Anything malformed or missing is conservative, never an implicit allow.
package scope

import (
	"encoding/binary"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

const (
	hostnameMax = 253
	urlMax      = 2048
	portMax     = 65535
	cidrTextMax = 64
	v6TextMax   = 45
	v4Bits      = 32
	addrBits    = 128
	v4MapBits   = addrBits - v4Bits
)

var (
	labelRE      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	digitsRE     = regexp.MustCompile(`^[0-9]+$`)
	prefixTextRE = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,2})$`)
)

// utf16Len mirrors JavaScript string length so the length limits agree with the TS side.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

func isBadHostRune(r rune) bool {
	return unicode.IsSpace(r) || strings.ContainsRune(`/\:@%[]`, r)
}

// NormaliseHost returns the canonical form of a target hostname (lowercase, IDNA to ASCII, one
// trailing dot removed, RFC 1123 labels). ok is false when raw is not a valid DNS name; IP
// literals are not hostnames.
func NormaliseHost(raw string) (host string, ok bool) {
	if raw == "" || utf16Len(raw) > hostnameMax+1 || strings.ContainsFunc(raw, isBadHostRune) {
		return "", false
	}
	trimmed := strings.TrimSuffix(raw, ".")
	if trimmed == "" || strings.ContainsRune(trimmed, '*') {
		return "", false
	}
	ascii, err := idna.Lookup.ToASCII(strings.ToLower(trimmed))
	if err != nil || ascii == "" || len(ascii) > hostnameMax {
		return "", false
	}
	labels := strings.Split(ascii, ".")
	for _, l := range labels {
		if !labelRE.MatchString(l) {
			return "", false
		}
	}
	// A numeric last label would make this an IP literal (or an ambiguous one); IPs belong in cidr.
	if digitsRE.MatchString(labels[len(labels)-1]) {
		return "", false
	}
	return ascii, true
}

// NormaliseHostPattern returns the canonical form of a rule host (exact or one leading `*.`
// wildcard with at least two labels after it).
func NormaliseHostPattern(raw string) (pattern string, ok bool) {
	if rest, found := strings.CutPrefix(raw, "*."); found {
		suffix, ok := NormaliseHost(rest)
		if !ok || !strings.Contains(suffix, ".") {
			return "", false
		}
		return "*." + suffix, true
	}
	return NormaliseHost(raw)
}

// u128 is an address in the 128-bit space; IPv4 is held as IPv4-mapped IPv6.
type u128 struct{ hi, lo uint64 }

func fromAddr(a netip.Addr) u128 {
	b := a.As16()
	return u128{binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:])}
}

func (a u128) mask(prefix int) u128 {
	switch {
	case prefix <= 0:
		return u128{}
	case prefix < 64:
		return u128{hi: a.hi &^ (^uint64(0) >> uint(prefix))}
	case prefix == 64:
		return u128{hi: a.hi}
	case prefix < addrBits:
		return u128{hi: a.hi, lo: a.lo &^ (^uint64(0) >> uint(prefix-64))}
	}
	return a
}

// ParseIP parses an IPv4 or IPv6 address strictly (no leading zeros, no zone) into the 128-bit
// space, IPv4 as IPv4-mapped IPv6.
func ParseIP(raw string) (ip netip.Addr, ok bool) {
	if len(raw) > v6TextMax || strings.ContainsRune(raw, '%') {
		return netip.Addr{}, false
	}
	a, err := netip.ParseAddr(raw)
	if err != nil {
		return netip.Addr{}, false
	}
	return a, true
}

// cidrT is a CIDR in the 128-bit space (an IPv4 /8 is /104).
type cidrT struct {
	network u128
	prefix  int
}

func (c cidrT) contains(a netip.Addr) bool { return fromAddr(a).mask(c.prefix) == c.network }

// parseCIDR parses a CIDR or bare address strictly; host bits set, bad prefixes and zones are
// rejected.
func parseCIDR(raw string) (cidrT, bool) {
	if len(raw) > cidrTextMax {
		return cidrT{}, false
	}
	addrText, prefixText, hasPrefix := strings.Cut(raw, "/")
	addr, ok := ParseIP(addrText)
	if !ok {
		return cidrT{}, false
	}
	maxPrefix := addrBits
	isV4 := addr.Is4()
	if isV4 {
		maxPrefix = v4Bits
	}
	prefix := maxPrefix
	if hasPrefix {
		if !prefixTextRE.MatchString(prefixText) {
			return cidrT{}, false
		}
		n := 0
		for _, d := range prefixText {
			n = n*10 + int(d-'0')
		}
		if n > maxPrefix {
			return cidrT{}, false
		}
		prefix = n
	}
	if isV4 {
		prefix += v4MapBits
	}
	v := fromAddr(addr)
	if v.mask(prefix) != v {
		return cidrT{}, false
	}
	return cidrT{network: v, prefix: prefix}, true
}

// NormalisePath returns the canonical form of a request or rule path: query and fragment
// dropped, percent-decoded exactly once, control characters rejected, `\` read as `/`, empty and
// `.` segments dropped, `..` resolved (clamped at the root), no trailing slash except the root.
// `%`, `?` and `#` are re-encoded so the form is idempotent. allowDotDot=false (rules) rejects
// `..` instead of resolving it.
func NormalisePath(raw string, allowDotDot bool) (path string, ok bool) {
	if raw == "" || utf16Len(raw) > urlMax {
		return "", false
	}
	bare := raw
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		bare = raw[:i]
	}
	if !strings.HasPrefix(bare, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(bare)
	if err != nil || !utf8.ValidString(decoded) {
		return "", false
	}
	for _, r := range decoded {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	segments := make([]string, 0, 8)
	for _, seg := range strings.Split(strings.ReplaceAll(decoded, `\`, "/"), "/") {
		switch seg {
		case "", ".":
		case "..":
			if !allowDotDot {
				return "", false
			}
			if len(segments) > 0 {
				segments = segments[:len(segments)-1]
			}
		default:
			segments = append(segments, strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(seg))
		}
	}
	return "/" + strings.Join(segments, "/"), true
}
