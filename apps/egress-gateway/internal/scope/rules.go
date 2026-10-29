package scope

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Limits shared with the TypeScript rule model (@blackwing/contracts scope.ts).
const (
	// RulesMax bounds the rules in one set, so evaluation stays cheap and bounded.
	RulesMax = 1000
	listMax  = 100
)

// ErrInvalidRule is returned (wrapped) for every malformed rule set. A rule set that fails to
// parse puts nothing in scope; callers must treat the error as a deny.
var ErrInvalidRule = errors.New("SCOPE_INVALID_RULE")

var starRun = regexp.MustCompile(`\*+`)

var httpMethods = map[string]struct{}{
	"GET": {}, "HEAD": {}, "OPTIONS": {}, "POST": {}, "PUT": {}, "PATCH": {}, "DELETE": {}, "CONNECT": {},
}

// Specificity indexes, compared lexicographically (see rule.spec).
const (
	specAddress = iota
	specPrefix
	specPath
	specPort
	specMethod
	specLen
)

const (
	specExactHost    = 3
	specWildcardHost = 2
	specCIDR         = 1
	specExact        = 2
	specPartial      = 1
)

type portSpec struct{ from, to int }

type pathPattern struct {
	literal string
	re      *regexp.Regexp // nil when literal has no `*`
}

type rule struct {
	index    int
	exclude  bool
	host     string // canonical; may start with "*."
	hasHost  bool
	cidr     *cidrT
	prefix   netip.Prefix // the cidr as a netip.Prefix (IPv4 unmapped); invalid when no cidr
	ports    []portSpec
	paths    []pathPattern
	methods  []string
	spec     [specLen]int
	describe string
}

// RuleSet is a parsed, canonical, precompiled scope rule set. It is immutable and safe for
// concurrent use. Rules are indexed by host (exact and wildcard suffix) so a lookup touches only
// the rules that can match the target host plus the (bounded, at most RulesMax) CIDR and
// address-less rules.
type RuleSet struct {
	rules    []*rule
	exact    map[string][]*rule
	wildcard map[string][]*rule // key: the suffix after "*."
	always   []*rule            // cidr-only and address-less rules
}

// Len is the number of rules in the set.
func (rs *RuleSet) Len() int {
	if rs == nil {
		return 0
	}
	return len(rs.rules)
}

type rawRule struct {
	Effect  json.RawMessage `json:"effect"`
	Host    json.RawMessage `json:"host"`
	CIDR    json.RawMessage `json:"cidr"`
	Ports   json.RawMessage `json:"ports"`
	Paths   json.RawMessage `json:"paths"`
	Methods json.RawMessage `json:"methods"`
}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidRule, fmt.Sprintf(format, a...))
}

func strictDecode(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func present(m json.RawMessage) (bool, error) {
	if m == nil {
		return false, nil
	}
	if bytes.Equal(bytes.TrimSpace(m), []byte("null")) {
		return false, errors.New("null is not allowed")
	}
	return true, nil
}

// ParseRules parses and canonicalises a rule set from untrusted JSON of the shape
// {"rules":[{"effect":"include|exclude","host":..,"cidr":..,"ports":[..],"paths":[..],"methods":[..]}]},
// exactly as @blackwing/contracts parseScopeRules does. Unknown fields, bad values and rule sets
// over RulesMax are rejected with an error wrapping ErrInvalidRule.
func ParseRules(data []byte) (*RuleSet, error) {
	var doc struct {
		Rules []json.RawMessage `json:"rules"`
	}
	if err := strictDecode(data, &doc); err != nil {
		return nil, invalid("rules document: %v", err)
	}
	if doc.Rules == nil || len(doc.Rules) > RulesMax {
		return nil, invalid("rules must be an array of at most %d", RulesMax)
	}
	rs := &RuleSet{
		exact:    map[string][]*rule{},
		wildcard: map[string][]*rule{},
	}
	for i, item := range doc.Rules {
		r, err := parseRule(i, item)
		if err != nil {
			return nil, invalid("rules.%d: %v", i, err)
		}
		rs.rules = append(rs.rules, r)
		switch {
		case r.hasHost && strings.HasPrefix(r.host, "*."):
			rs.wildcard[r.host[2:]] = append(rs.wildcard[r.host[2:]], r)
		case r.hasHost:
			rs.exact[r.host] = append(rs.exact[r.host], r)
		default:
			rs.always = append(rs.always, r)
		}
	}
	return rs, nil
}

func parseRule(index int, item json.RawMessage) (*rule, error) {
	var raw rawRule
	if err := strictDecode(item, &raw); err != nil {
		return nil, err
	}
	r := &rule{index: index}
	var effect string
	if err := json.Unmarshal(raw.Effect, &effect); err != nil || (effect != "include" && effect != "exclude") {
		return nil, errors.New("effect must be include or exclude")
	}
	r.exclude = effect == "exclude"

	if ok, err := present(raw.Host); err != nil {
		return nil, fmt.Errorf("host: %w", err)
	} else if ok {
		var s string
		if err := json.Unmarshal(raw.Host, &s); err != nil {
			return nil, errors.New("host must be a string")
		}
		host, ok := NormaliseHostPattern(s)
		if !ok {
			return nil, errors.New("host is not a valid host pattern")
		}
		r.host, r.hasHost = host, true
	}
	if ok, err := present(raw.CIDR); err != nil {
		return nil, fmt.Errorf("cidr: %w", err)
	} else if ok {
		var s string
		if err := json.Unmarshal(raw.CIDR, &s); err != nil {
			return nil, errors.New("cidr must be a string")
		}
		c, ok := parseCIDR(s)
		if !ok {
			return nil, errors.New("cidr is not a valid CIDR")
		}
		r.cidr = &c
		r.prefix = unmapPrefix(c)
	}
	if err := parsePorts(r, raw.Ports); err != nil {
		return nil, err
	}
	if err := parsePaths(r, raw.Paths); err != nil {
		return nil, err
	}
	if err := parseMethods(r, raw.Methods); err != nil {
		return nil, err
	}

	// An include must name an address, or it would bring every host on the internet into scope.
	if !r.exclude && !r.hasHost && r.cidr == nil {
		return nil, errors.New("an include rule needs a host or cidr")
	}
	if !r.hasHost && r.cidr == nil && r.ports == nil && r.paths == nil && r.methods == nil {
		return nil, errors.New("rule constrains nothing")
	}
	r.finish(effect)
	return r, nil
}

// unmapPrefix converts a parsed 128-bit CIDR back to a netip.Prefix, IPv4 unmapped, so the lab gate
// can compare it with the IPv4 blocked-range table.
func unmapPrefix(c cidrT) netip.Prefix {
	addr := c.network.addr()
	bits := c.prefix
	if addr.Is4In6() && bits >= v4MapBits {
		addr = addr.Unmap()
		bits -= v4MapBits
	}
	return netip.PrefixFrom(addr, bits)
}

func parseList(m json.RawMessage, field string) ([]json.RawMessage, error) {
	if ok, err := present(m); err != nil {
		return nil, fmt.Errorf("%s: %w", field, err)
	} else if !ok {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(m, &items); err != nil || len(items) == 0 || len(items) > listMax {
		return nil, fmt.Errorf("%s must be a list of 1 to %d items", field, listMax)
	}
	return items, nil
}

func parsePorts(r *rule, m json.RawMessage) error {
	items, err := parseList(m, "ports")
	if err != nil {
		return err
	}
	for _, it := range items {
		var spec portSpec
		var single int
		if json.Unmarshal(it, &single) == nil {
			spec = portSpec{single, single}
		} else {
			var rng struct {
				From *int `json:"from"`
				To   *int `json:"to"`
			}
			if err := strictDecode(it, &rng); err != nil || rng.From == nil || rng.To == nil {
				return errors.New("ports: not a port or {from,to} range")
			}
			spec = portSpec{*rng.From, *rng.To}
		}
		if spec.from < 1 || spec.to > portMax || spec.from > spec.to {
			return errors.New("ports: out of range 1-65535 or reversed")
		}
		r.ports = append(r.ports, spec)
	}
	return nil
}

func parsePaths(r *rule, m json.RawMessage) error {
	items, err := parseList(m, "paths")
	if err != nil {
		return err
	}
	for _, it := range items {
		var s string
		if err := json.Unmarshal(it, &s); err != nil {
			return errors.New("paths must be strings")
		}
		p, ok := NormalisePath(s, false)
		if !ok {
			return errors.New("paths: invalid rule path")
		}
		pp := pathPattern{literal: p}
		if strings.Contains(p, "*") {
			pp.re = globRegexp(p)
		}
		r.paths = append(r.paths, pp)
	}
	return nil
}

func parseMethods(r *rule, m json.RawMessage) error {
	items, err := parseList(m, "methods")
	if err != nil {
		return err
	}
	for _, it := range items {
		var s string
		if err := json.Unmarshal(it, &s); err != nil {
			return errors.New("methods must be strings")
		}
		s = strings.ToUpper(s)
		if _, ok := httpMethods[s]; !ok {
			return errors.New("methods: unknown HTTP method")
		}
		r.methods = append(r.methods, s)
	}
	return nil
}

// globRegexp compiles a rule path glob exactly as the TS matcher does: `*` matches any run of
// characters inside one segment; a `**` segment matches zero or more whole segments.
func globRegexp(pattern string) *regexp.Regexp {
	var src strings.Builder
	for _, seg := range strings.Split(pattern, "/") {
		if seg == "" {
			continue
		}
		if seg == "**" {
			src.WriteString(`(?:/[^/]+)*`)
			continue
		}
		parts := starRun.Split(seg, -1)
		for i, p := range parts {
			parts[i] = regexp.QuoteMeta(p)
		}
		src.WriteString("/" + strings.Join(parts, "[^/]*"))
	}
	body := src.String()
	if body == "" {
		body = "/"
	}
	return regexp.MustCompile("^" + body + "$")
}

// finish computes the specificity vector [address, cidrPrefix, path, port, method] and the
// label that is reported as MatchedRule.
func (r *rule) finish(effect string) {
	switch {
	case r.hasHost && strings.HasPrefix(r.host, "*."):
		r.spec[specAddress] = specWildcardHost
	case r.hasHost:
		r.spec[specAddress] = specExactHost
	case r.cidr != nil:
		r.spec[specAddress] = specCIDR
	}
	if r.cidr != nil {
		r.spec[specPrefix] = r.cidr.prefix
	}
	if r.paths != nil {
		r.spec[specPath] = specExact
		for _, p := range r.paths {
			if p.re != nil {
				r.spec[specPath] = specPartial
			}
		}
	}
	if r.ports != nil {
		r.spec[specPort] = specExact
		for _, p := range r.ports {
			if p.from != p.to {
				r.spec[specPort] = specPartial
			}
		}
	}
	if r.methods != nil {
		r.spec[specMethod] = 1
	}
	r.describe = fmt.Sprintf("rules[%d] %s", r.index, effect)
}

// IPInScope reports whether an include rule with a cidr (or bare IP) contains ip and
// no exclude rule with a cidr does. It is the netguard.ScopeRules hook: the only way a private,
// loopback or metadata address becomes dialable (S8.2). Host-only rules never count, and port,
// path and method are left to the normal per-request check. A nil set includes nothing.
func (rs *RuleSet) IPInScope(ip netip.Addr) bool {
	if rs == nil || !ip.IsValid() {
		return false
	}
	included := false
	for _, r := range rs.rules {
		if r.cidr == nil || !r.cidr.contains(ip) {
			continue
		}
		if r.exclude {
			return false
		}
		included = true
	}
	return included
}
