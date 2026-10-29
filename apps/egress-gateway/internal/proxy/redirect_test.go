package proxy_test

import (
	"net/netip"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netguard"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/proxy"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/scope"
)

func TestRedirectInScope(t *testing.T) {
	rs, err := scope.ParseRules([]byte(`{"rules":[
	 {"effect":"include","host":"app.example.test"},
	 {"effect":"include","host":"*.example.test","ports":[8443]},
	 {"effect":"include","cidr":"10.8.0.0/24"}]}`))
	require.NoError(t, err)
	base, _ := url.Parse("https://app.example.test/login")
	g := netguard.Default()
	cases := map[string]bool{
		"/dashboard":                                    true,
		"https://evil.test/x":                           false,
		"http://app.example.test/x":                     true,
		"https://sub.example.test:8443/x":               true,
		"https://sub.example.test/x":                    false,
		"http://169.254.169.254/latest":                 false,
		"http://2852039166/latest":                      false,
		"http://0251.0376.0251.0376/":                   false,
		"http://[::ffff:169.254.169.254]/":              false,
		"http://10.8.0.5/":                              true,
		"http://10.9.0.5/":                              false,
		"http://127.0.0.1/":                             false,
		"ftp://app.example.test/":                       false,
		"//app.example.test/p":                          true,
		"http://1.2.3.4.5/":                             false,
		"http://:80/":                                   false,
		"http://app.example.test:99999999999999999999/": false,
		"%zz": false,
	}
	for loc, want := range cases {
		assert.Equal(t, want, proxy.RedirectInScope(base, loc, rs, g), loc)
	}
	assert.False(t, proxy.RedirectInScope(nil, "/x", rs, g))
	assert.False(t, proxy.RedirectInScope(base, "/x", rs, nil))
	assert.False(t, proxy.RedirectInScope(base, "http://app.example.test/", nil, g), "no scope fails closed")
}

// A lab rule admits only the lab address; a redirect from the lab to loopback, metadata or another
// private address is out of scope (#880).
func TestRedirectFromLabToPrivateIsOutOfScope(t *testing.T) {
	rs, err := scope.ParseLabRules([]byte(`{"rules":[
	 {"effect":"include","host":"juice-shop","ports":[3000]},
	 {"effect":"include","cidr":"172.30.250.0/24","ports":[3000]}]}`), scope.LabContext{
		Env: scope.EnvDev, Verified: true, Networks: []netip.Prefix{netip.MustParsePrefix("172.30.250.0/24")},
	})
	require.NoError(t, err)
	base, _ := url.Parse("http://juice-shop:3000/rest/products")
	g := netguard.Default()
	cases := map[string]bool{
		"http://juice-shop:3000/next":        true,
		"http://172.30.250.7:3000/next":      true,
		"http://127.0.0.1:3000/next":         false,
		"http://[::1]:3000/next":             false,
		"http://169.254.169.254/latest/meta": false,
		"http://172.30.251.7:3000/next":      false,
		"http://10.0.0.1:3000/next":          false,
	}
	for loc, want := range cases {
		assert.Equal(t, want, proxy.RedirectInScope(base, loc, rs, g), loc)
	}
}
