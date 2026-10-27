package scope

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Target is a concrete request target. A nil field is "not known": a rule that constrains a
// dimension the target lacks never brings it into scope (include) and still applies as a
// deny (exclude). A present but malformed value (including port 0, an empty path or an
// out-of-range port) makes the whole target out of scope.
type Target struct {
	// Host is the hostname the client asked for. IP literals are not hostnames; put them in IP.
	Host *string `json:"host,omitempty"`
	// IP is the address actually being connected to (the pinned, resolved IP for named hosts).
	IP *string `json:"ip,omitempty"`
	// Port is the destination TCP port.
	Port *int `json:"port,omitempty"`
	// Path is the request path; any query or fragment is ignored.
	Path *string `json:"path,omitempty"`
	// Method is the HTTP method, case-insensitive.
	Method *string `json:"method,omitempty"`
}

// Decision is the outcome of Match. Reason is safe to log: it never contains the query string
// or any target value. MatchedRule is empty and MatchedRuleIndex is -1 when no rule matched.
type Decision struct {
	Allow            bool
	MatchedRule      string
	MatchedRuleIndex int
	Reason           string
}

func deny(reason string) Decision {
	return Decision{MatchedRuleIndex: -1, Reason: "default-deny: " + reason}
}

type normTarget struct {
	host      string
	hasHost   bool
	ip        netip.Addr
	hasIP     bool
	port      int
	hasPort   bool
	path      string
	hasPath   bool
	method    string
	hasMethod bool
}

var methodRE = regexp.MustCompile(`^[A-Z]{1,20}$`)

func normaliseTarget(t Target) (normTarget, string) {
	var n normTarget
	if t.Host != nil {
		host, ok := NormaliseHost(*t.Host)
		if !ok {
			return n, "invalid target host"
		}
		n.host, n.hasHost = host, true
	}
	if t.IP != nil {
		ip, ok := ParseIP(*t.IP)
		if !ok {
			return n, "invalid target ip"
		}
		n.ip, n.hasIP = ip, true
	}
	if t.Port != nil {
		if *t.Port < 1 || *t.Port > portMax {
			return n, "invalid target port"
		}
		n.port, n.hasPort = *t.Port, true
	}
	if t.Path != nil {
		path, ok := NormalisePath(*t.Path, true)
		if !ok {
			return n, "invalid target path"
		}
		n.path, n.hasPath = path, true
	}
	if t.Method != nil {
		m := strings.ToUpper(*t.Method)
		if !methodRE.MatchString(m) {
			return n, "invalid target method"
		}
		n.method, n.hasMethod = m, true
	}
	if !n.hasHost && !n.hasIP {
		return n, "target has no host or ip"
	}
	return n, ""
}

// dimension outcome for port, path and method: matched, did not match, or the target lacks it.
type dimension int

const (
	dimMatch dimension = iota
	dimMiss
	dimAbsent
)

func hostMatches(pattern, host string) bool {
	suffix, wildcard := strings.CutPrefix(pattern, "*")
	if !wildcard {
		return pattern == host
	}
	label, found := strings.CutSuffix(host, suffix)
	return found && label != "" && !strings.Contains(label, ".")
}

func pathMatches(p pathPattern, path string) bool {
	if p.re == nil {
		return p.literal == path
	}
	return p.re.MatchString(path) || (path == "/" && p.re.MatchString(""))
}

// applies reports whether the rule matches the target: an include needs every dimension it sets
// to match; an exclude applies unless a dimension positively misses (a dimension it cannot
// rule out fails closed).
func (r *rule) applies(t *normTarget) bool {
	check := func(d dimension) bool {
		if r.exclude {
			return d != dimMiss
		}
		return d == dimMatch
	}
	// Host and cidr select which rules apply at all: a miss (or a missing address) is a miss for
	// both effects.
	if r.hasHost && (!t.hasHost || !hostMatches(r.host, t.host)) {
		return false
	}
	if r.cidr != nil && (!t.hasIP || !r.cidr.contains(t.ip)) {
		return false
	}
	if r.ports != nil {
		d := dimAbsent
		if t.hasPort {
			d = dimMiss
			for _, p := range r.ports {
				if p.from <= t.port && t.port <= p.to {
					d = dimMatch
					break
				}
			}
		}
		if !check(d) {
			return false
		}
	}
	if r.paths != nil {
		d := dimAbsent
		if t.hasPath {
			d = dimMiss
			for _, p := range r.paths {
				if pathMatches(p, t.path) {
					d = dimMatch
					break
				}
			}
		}
		if !check(d) {
			return false
		}
	}
	if r.methods != nil {
		d := dimAbsent
		if t.hasMethod {
			d = dimMiss
			for _, m := range r.methods {
				if m == t.method {
					d = dimMatch
					break
				}
			}
		}
		if !check(d) {
			return false
		}
	}
	return true
}

// better orders matching rules: more specific first (lexicographic over the specificity
// vector), then exclude over include (fail closed), then the earlier rule. It is a total order,
// so the result does not depend on the order candidates are visited.
func (r *rule) better(o *rule) bool {
	for i := range r.spec {
		if r.spec[i] != o.spec[i] {
			return r.spec[i] > o.spec[i]
		}
	}
	if r.exclude != o.exclude {
		return r.exclude
	}
	return r.index < o.index
}

// Match decides whether target is in scope under rs. It never panics and never allows by
// default: a nil or empty rule set, a malformed target, or no matching include is a deny.
// Callers log Reason and MatchedRule on denial and record egress_scope_eval_total.
func Match(target Target, rs *RuleSet) Decision {
	if rs.Len() == 0 {
		return deny("no rules")
	}
	t, bad := normaliseTarget(target)
	if bad != "" {
		return deny(bad)
	}

	var best *rule
	consider := func(rules []*rule) {
		for _, r := range rules {
			if (best == nil || r.better(best)) && r.applies(&t) {
				best = r
			}
		}
	}
	if t.hasHost {
		consider(rs.exact[t.host])
		if _, parent, ok := strings.Cut(t.host, "."); ok {
			consider(rs.wildcard[parent])
		}
	}
	consider(rs.always)

	if best == nil {
		return deny("no rule matched")
	}
	d := Decision{Allow: !best.exclude, MatchedRule: best.describe, MatchedRuleIndex: best.index}
	if best.exclude {
		d.Reason = fmt.Sprintf("excluded by rule %d", best.index)
	} else {
		d.Reason = fmt.Sprintf("included by rule %d", best.index)
	}
	return d
}
