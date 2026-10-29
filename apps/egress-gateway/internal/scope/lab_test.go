package scope_test

import (
	"net/netip"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netguard"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/scope"
)

var labNet = netip.MustParsePrefix("172.30.250.0/24")

func devLab(networks ...netip.Prefix) scope.LabContext {
	if len(networks) == 0 {
		networks = []netip.Prefix{labNet}
	}
	return scope.LabContext{Env: scope.EnvDev, Verified: true, Networks: networks}
}

// labRules is the seeded shape: the Juice Shop service on its port, admitted by the lab cidr.
func labRules(cidr string) []byte {
	return []byte(`{"rules":[
	 {"effect":"include","host":"juice-shop","ports":[3000]},
	 {"effect":"include","cidr":"` + cidr + `","ports":[3000]},
	 {"effect":"exclude","host":"juice-shop","paths":["/rest/admin/application-version"]}]}`)
}

func TestPrivateRuleAdmittedOnlyInVerifiedDevLab(t *testing.T) {
	rs, err := scope.ParseLabRules(labRules("172.30.250.0/24"), devLab())
	require.NoError(t, err)
	require.NotNil(t, rs)

	for _, env := range []string{"production", "staging", "", "DEV", "dev "} {
		lab := devLab()
		lab.Env = env
		_, envErr := scope.ParseLabRules(labRules("172.30.250.0/24"), lab)
		assert.ErrorIs(t, envErr, scope.ErrLabRule, "env %q", env)
	}
	unverified := devLab()
	unverified.Verified = false
	_, err = scope.ParseLabRules(labRules("172.30.250.0/24"), unverified)
	assert.ErrorIs(t, err, scope.ErrLabRule, "unverified asset")

	_, err = scope.ParseLabRules(labRules("172.30.250.0/24"), scope.LabContext{})
	assert.ErrorIs(t, err, scope.ErrLabRule, "zero context admits no private range")
}

func TestPrivateRuleMustStayInsideLabNetwork(t *testing.T) {
	cases := map[string]string{
		"outside the lab network": "172.30.251.0/24",
		"wider than the lab":      "172.30.0.0/16",
		"rfc1918 elsewhere":       "10.0.0.0/8",
		"single host outside":     "172.30.251.7/32",
		"cgnat":                   "100.64.0.0/10",
		"everything":              "0.0.0.0/0",
		"ipv6 everything":         "::/0",
	}
	for name, cidr := range cases {
		_, err := scope.ParseLabRules(labRules(cidr), devLab())
		assert.ErrorIs(t, err, scope.ErrLabRule, name)
	}
	// A single host inside the lab is admitted, as is the exact network.
	for _, cidr := range []string{"172.30.250.7/32", "172.30.250.0/24", "172.30.250.7"} {
		_, err := scope.ParseLabRules(labRules(cidr), devLab())
		assert.NoError(t, err, cidr)
	}
}

func TestLoopbackLinkLocalAndMetadataNeverAdmitted(t *testing.T) {
	for _, cidr := range []string{"127.0.0.1/32", "127.0.0.0/8", "::1", "169.254.169.254/32", "169.254.0.0/16", "fe80::/10", "fd00:ec2::254"} {
		_, err := scope.ParseLabRules(labRules(cidr), devLab())
		assert.ErrorIs(t, err, scope.ErrLabRule, cidr)
	}
	// Even a lab network that names them is refused.
	for _, net := range []string{"127.0.0.0/8", "169.254.0.0/16"} {
		_, err := scope.ParseLabRules(labRules("127.0.0.1/32"), devLab(netip.MustParsePrefix(net)))
		assert.ErrorIs(t, err, scope.ErrLabRule, "lab network "+net)
	}
}

func TestPublicLabNetworkRefused(t *testing.T) {
	lab := devLab(netip.MustParsePrefix("93.184.216.0/24"))
	_, err := scope.ParseLabRules(labRules("93.184.216.0/24"), lab)
	assert.ErrorIs(t, err, scope.ErrLabRule)
	lab = devLab(netip.MustParsePrefix("0.0.0.0/0"))
	_, err = scope.ParseLabRules([]byte(`{"rules":[{"effect":"include","cidr":"10.0.0.0/8"}]}`), lab)
	assert.ErrorIs(t, err, scope.ErrLabRule, "a broad network is not a private lab")
}

func TestLabGateIgnoresPublicHostAndExcludeRules(t *testing.T) {
	// Public and host-only includes need no lab, and excludes only narrow scope.
	doc := []byte(`{"rules":[
	 {"effect":"include","host":"app.example.test"},
	 {"effect":"include","cidr":"93.184.216.34/32"},
	 {"effect":"exclude","cidr":"10.0.0.0/8"}]}`)
	_, err := scope.ParseLabRules(doc, scope.LabContext{})
	assert.NoError(t, err)
}

func TestIPv4MappedAndIPv6LabForms(t *testing.T) {
	_, err := scope.ParseLabRules(labRules("::ffff:172.30.250.0/120"), devLab())
	assert.NoError(t, err, "IPv4-mapped form of the lab cidr")
	_, err = scope.ParseLabRules(labRules("::ffff:172.30.251.0/120"), devLab())
	assert.ErrorIs(t, err, scope.ErrLabRule, "IPv4-mapped form outside the lab")

	v6 := devLab(netip.MustParsePrefix("fd00:30::/64"))
	_, err = scope.ParseLabRules([]byte(`{"rules":[{"effect":"include","cidr":"fd00:30::1/128"}]}`), v6)
	assert.NoError(t, err, "IPv6 ULA lab")
	_, err = scope.ParseLabRules([]byte(`{"rules":[{"effect":"include","cidr":"fd00:31::1/128"}]}`), v6)
	assert.ErrorIs(t, err, scope.ErrLabRule, "IPv6 outside the lab")
}

// DNS rebinding (#880, #194): the resolved address is re-checked at dial time, so an answer that
// moves to another private address is refused even though the name is in scope.
func TestRebindingToAnotherPrivateAddressIsBlocked(t *testing.T) {
	rs, err := scope.ParseLabRules(labRules("172.30.250.0/24"), devLab())
	require.NoError(t, err)
	ctl := netguard.Default().DialControl(rs, nil)
	require.NoError(t, ctl("tcp", "172.30.250.7:3000", nil), "pinned lab address")
	err = ctl("tcp", "172.30.251.7:3000", nil)
	assert.ErrorIs(t, err, netguard.ErrBlocked, "rebound private address outside the lab")
	err = ctl("tcp", "10.1.2.3:3000", nil)
	assert.ErrorIs(t, err, netguard.ErrBlocked, "rebound to rfc1918")
	err = ctl("tcp", "169.254.169.254:80", nil)
	assert.ErrorIs(t, err, netguard.ErrBlocked, "rebound to metadata")
	err = ctl("tcp", "127.0.0.1:3000", nil)
	assert.ErrorIs(t, err, netguard.ErrBlocked, "rebound to loopback")
}

func TestNilRuleSetPassesLabGate(t *testing.T) {
	var rs *scope.RuleSet
	assert.NoError(t, rs.CheckLab(scope.LabContext{}))
}
