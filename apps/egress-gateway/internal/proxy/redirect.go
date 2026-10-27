package proxy

import (
	"net/url"
	"strconv"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netguard"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/scope"
)

// RedirectInScope reports whether following a 3xx Location from base would stay in scope. The
// gateway never follows redirects itself; it uses this to annotate the response and evidence
// with redirect_in_scope (EGRESS-009). A follow-up request is still denied by the normal
// per-request check, so this is advisory for the agent. Anything unparseable, non-http(s) or
// pointing at an address netguard blocks is out of scope (fail closed).
func RedirectInScope(base *url.URL, location string, rs *scope.RuleSet, g *netguard.Guard) bool {
	if base == nil || g == nil {
		return false
	}
	ref, err := url.Parse(location)
	if err != nil {
		return false
	}
	u := base.ResolveReference(ref)
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	if host == "" {
		return false
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if ps := u.Port(); ps != "" {
		if port, err = strconv.Atoi(ps); err != nil {
			return false
		}
	}
	path, method := u.Path, "GET"
	if path == "" {
		path = "/"
	}
	t := scope.Target{Port: &port, Path: &path, Method: &method}
	ip, lerr := netguard.ParseLiteral(host)
	switch lerr {
	case nil:
		if g.IsBlocked(ip, rs) {
			return false
		}
		s := ip.String()
		t.IP = &s
	case netguard.ErrNotLiteral:
		h, ok := scope.NormaliseHost(host)
		if !ok {
			return false
		}
		t.Host = &h
	default:
		return false
	}
	return scope.Match(t, rs).Allow
}
