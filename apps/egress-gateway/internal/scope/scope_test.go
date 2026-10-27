package scope

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The shared TS/Go contract: the same file is run by @blackwing/contracts and
// @blackwing/domain (matchScope) in Vitest.
const sharedVectors = "../../../../packages/contracts/src/scope.vectors.json"

type vectorFile struct {
	Vectors []struct {
		Name   string          `json:"name"`
		Rules  json.RawMessage `json:"rules"`
		Target Target          `json:"target"`
		Expect struct {
			InScope          bool `json:"inScope"`
			MatchedRuleIndex *int `json:"matchedRuleIndex"`
		} `json:"expect"`
	} `json:"vectors"`
	InvalidRules []struct {
		Name string          `json:"name"`
		Rule json.RawMessage `json:"rule"`
	} `json:"invalidRules"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(sharedVectors)
	require.NoError(t, err)
	var f vectorFile
	require.NoError(t, json.Unmarshal(raw, &f))
	return f
}

func TestSharedVectors(t *testing.T) {
	f := loadVectors(t)
	require.GreaterOrEqual(t, len(f.Vectors), 40)
	for _, v := range f.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			rs, err := ParseRules(v.Rules)
			require.NoError(t, err)
			d := Match(v.Target, rs)
			require.Equal(t, v.Expect.InScope, d.Allow, d.Reason)
			require.NotEmpty(t, d.Reason)
			if v.Expect.MatchedRuleIndex == nil {
				require.Equal(t, -1, d.MatchedRuleIndex)
				require.Empty(t, d.MatchedRule)
			} else {
				require.Equal(t, *v.Expect.MatchedRuleIndex, d.MatchedRuleIndex)
				require.NotEmpty(t, d.MatchedRule)
			}
		})
	}
}

func TestSharedInvalidRulesRejected(t *testing.T) {
	f := loadVectors(t)
	require.NotEmpty(t, f.InvalidRules)
	for _, v := range f.InvalidRules {
		t.Run(v.Name, func(t *testing.T) {
			doc := fmt.Sprintf(`{"rules":[%s]}`, v.Rule)
			rs, err := ParseRules([]byte(doc))
			require.Nil(t, rs)
			require.ErrorIs(t, err, ErrInvalidRule)
		})
	}
}

func str(s string) *string { return &s }
func num(n int) *int       { return &n }

func mustRules(t *testing.T, doc string) *RuleSet {
	t.Helper()
	rs, err := ParseRules([]byte(doc))
	require.NoError(t, err)
	return rs
}

func TestDocumentRejections(t *testing.T) {
	for name, doc := range map[string]string{
		"not json":         `{`,
		"missing rules":    `{}`,
		"null rules":       `{"rules":null}`,
		"unknown top key":  `{"rules":[],"extra":1}`,
		"trailing data":    `{"rules":[]} {}`,
		"null host":        `{"rules":[{"effect":"include","host":null,"cidr":"10.0.0.0/8"}]}`,
		"host is a number": `{"rules":[{"effect":"include","host":1}]}`,
		"range extra key":  `{"rules":[{"effect":"include","host":"a.example.test","ports":[{"from":1,"to":2,"x":3}]}]}`,
		"range missing to": `{"rules":[{"effect":"include","host":"a.example.test","ports":[{"from":1}]}]}`,
		"101 ports":        `{"rules":[{"effect":"include","host":"a.example.test","ports":[` + strings.TrimSuffix(strings.Repeat("1,", 101), ",") + `]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseRules([]byte(doc))
			require.True(t, errors.Is(err, ErrInvalidRule), "%v", err)
		})
	}
}

func TestRuleSetSizeLimit(t *testing.T) {
	rule := `{"effect":"include","host":"a.example.test"}`
	build := func(n int) string {
		return `{"rules":[` + strings.TrimSuffix(strings.Repeat(rule+",", n), ",") + `]}`
	}
	_, err := ParseRules([]byte(build(RulesMax)))
	require.NoError(t, err)
	_, err = ParseRules([]byte(build(RulesMax + 1)))
	require.ErrorIs(t, err, ErrInvalidRule)
}

func TestEmptyAndNilRuleSetDenyAll(t *testing.T) {
	target := Target{Host: str("app.example.test")}
	for _, rs := range []*RuleSet{nil, mustRules(t, `{"rules":[]}`)} {
		d := Match(target, rs)
		require.False(t, d.Allow)
		require.Equal(t, "default-deny: no rules", d.Reason)
	}
}

func TestMalformedTargetsAreDenied(t *testing.T) {
	rs := mustRules(t, `{"rules":[{"effect":"include","host":"app.example.test","paths":["/**"]},{"effect":"include","cidr":"10.0.0.0/8"}]}`)
	host := str("app.example.test")
	for name, target := range map[string]Target{
		"empty":            {},
		"empty host":       {Host: str("")},
		"host with space":  {Host: str("bad host")},
		"bad ip":           {IP: str("300.1.1.1")},
		"empty ip":         {IP: str("")},
		"port zero":        {Host: host, Port: num(0)},
		"port negative":    {Host: host, Port: num(-1)},
		"port too large":   {Host: host, Port: num(65536)},
		"empty path":       {Host: host, Path: str("")},
		"relative path":    {Host: host, Path: str("api")},
		"nul in path":      {Host: host, Path: str("/a\x00b")},
		"encoded nul":      {Host: host, Path: str("/a%00b")},
		"control char":     {Host: host, Path: str("/a\tb")},
		"bad percent":      {Host: host, Path: str("/%")},
		"bad utf8":         {Host: host, Path: str("/\xff")},
		"empty method":     {Host: host, Method: str("")},
		"method with kind": {Host: host, Method: str("GE T")},
		"ip literal host":  {Host: str("10.0.0.1")},
	} {
		t.Run(name, func(t *testing.T) {
			d := Match(target, rs)
			require.False(t, d.Allow)
			require.True(t, strings.HasPrefix(d.Reason, "default-deny: "), d.Reason)
		})
	}
}

func TestIDNAndPunycodeAreOneRule(t *testing.T) {
	for _, rule := range []string{"bücher.example.test", "xn--bcher-kva.example.test", "BÜCHER.Example.TEST."} {
		rs := mustRules(t, fmt.Sprintf(`{"rules":[{"effect":"include","host":%q}]}`, rule))
		for _, h := range []string{"bücher.example.test", "xn--bcher-kva.example.test", "BÜCHER.example.test", "xn--bcher-kva.example.test."} {
			require.True(t, Match(Target{Host: str(h)}, rs).Allow, "%s vs %s", rule, h)
		}
	}
}

func TestTraversalIsMatchedAgainstNormalisedPath(t *testing.T) {
	rs := mustRules(t, `{"rules":[{"effect":"include","host":"app.example.test"},{"effect":"exclude","host":"app.example.test","paths":["/etc/**"]}]}`)
	for _, p := range []string{"/a/../../etc", "/a/../../etc/passwd", "/a/%2e%2e/%2e%2e/etc/passwd", "/a%2f..%2f..%2fetc", `/a\..\..\etc`} {
		d := Match(Target{Host: str("app.example.test"), Path: str(p)}, rs)
		require.False(t, d.Allow, p)
		require.Equal(t, 1, d.MatchedRuleIndex, p)
	}
	// Decoded once only: %252e%252e stays a literal segment and is not a traversal.
	require.True(t, Match(Target{Host: str("app.example.test"), Path: str("/a/%252e%252e/etc")}, rs).Allow)
}

func TestNormalisePath(t *testing.T) {
	for in, want := range map[string]string{
		"/":                  "/",
		"//a///b/":           "/a/b",
		"/a/./b":             "/a/b",
		"/a/b/../c?x=/../..": "/a/c",
		"/a#frag":            "/a",
		"/../..":             "/",
		"/caf%C3%A9":         "/café",
		"/a%25b":             "/a%25b",
		"/a%3Fb":             "/a%3Fb",
	} {
		got, ok := NormalisePath(in, true)
		require.True(t, ok, in)
		require.Equal(t, want, got, in)
		again, ok := NormalisePath(got, true)
		require.True(t, ok)
		require.Equal(t, got, again, "idempotent: %s", in)
	}
	_, ok := NormalisePath("/"+strings.Repeat("a", urlMax), true)
	require.False(t, ok)
}

func TestNormaliseHost(t *testing.T) {
	for in, want := range map[string]string{
		"Example.COM":  "example.com",
		"example.com.": "example.com",
		"a-b.example":  "a-b.example",
	} {
		got, ok := NormaliseHost(in)
		require.True(t, ok, in)
		require.Equal(t, want, got)
	}
	for _, in := range []string{"", ".", "example.com..", "-a.example", "a_b.example", "*.example.com", "a.b:1", "1.2.3.4", "example.123", strings.Repeat("a", 64) + ".example", strings.Repeat("a.", 130) + "com"} {
		_, ok := NormaliseHost(in)
		require.False(t, ok, in)
	}
}

func TestCIDRParsing(t *testing.T) {
	for _, ok := range []string{"10.0.0.0/8", "0.0.0.0/0", "192.0.2.10", "2001:db8::/32", "::/0", "::ffff:10.0.0.0/104", "2001:db8::5/128"} {
		_, got := parseCIDR(ok)
		require.True(t, got, ok)
	}
	for _, bad := range []string{"", "/8", "10.0.0.1/8", "10.0.0.0/33", "10.0.0.0/08", "10.00.0.0/16", "2001:db8::/129", "fe80::1%eth0", "2001::db8::1", "10.0.0.0/", "10.0.0.0/8/8", "10.0.0.0/-1"} {
		_, got := parseCIDR(bad)
		require.False(t, got, bad)
	}
}

func TestCIDRMaskBoundaries(t *testing.T) {
	for _, tc := range []struct {
		cidr, in string
		want     bool
	}{
		{"2001:db8::/64", "2001:db8::ffff:ffff:ffff:ffff", true},
		{"2001:db8::/64", "2001:db8:0:1::", false},
		{"2001:db8::/65", "2001:db8::7fff:ffff:ffff:ffff", true},
		{"2001:db8::/65", "2001:db8::8000:0:0:0", false},
		{"2001:db8::/127", "2001:db8::1", true},
		{"2001:db8::/127", "2001:db8::2", false},
		{"::/1", "7fff::1", true},
		{"::/1", "8000::1", false},
		{"::/0", "2001:db8::1", true},
		{"0.0.0.0/0", "8.8.8.8", true},
		{"0.0.0.0/0", "2001:db8::1", false},
	} {
		rs := mustRules(t, fmt.Sprintf(`{"rules":[{"effect":"include","cidr":%q}]}`, tc.cidr))
		require.Equal(t, tc.want, Match(Target{IP: str(tc.in)}, rs).Allow, "%s %s", tc.cidr, tc.in)
	}
}

func TestHostRuleNeverAuthorisesIPsAndViceVersa(t *testing.T) {
	hostRule := mustRules(t, `{"rules":[{"effect":"include","host":"app.example.test"}]}`)
	require.False(t, Match(Target{IP: str("93.184.216.34")}, hostRule).Allow)
	// The rebinding case: the name is in scope but the resolved IP is excluded by CIDR.
	both := mustRules(t, `{"rules":[{"effect":"include","host":"app.example.test"},{"effect":"include","cidr":"203.0.113.0/24"}]}`)
	require.True(t, Match(Target{Host: str("app.example.test")}, both).Allow)
	require.True(t, Match(Target{IP: str("203.0.113.9")}, both).Allow)
	require.False(t, Match(Target{IP: str("169.254.169.254")}, both).Allow)
	cidrRule := mustRules(t, `{"rules":[{"effect":"include","cidr":"203.0.113.0/24"}]}`)
	require.False(t, Match(Target{Host: str("app.example.test")}, cidrRule).Allow)
}

func TestMethodWildcardNeedsListing(t *testing.T) {
	_, err := ParseRules([]byte(`{"rules":[{"effect":"include","host":"a.example.test","methods":["*"]}]}`))
	require.ErrorIs(t, err, ErrInvalidRule)
}

func TestSingletonRangeIsExact(t *testing.T) {
	rs := mustRules(t, `{"rules":[{"effect":"exclude","host":"a.example.test","ports":[{"from":8000,"to":8100}]},{"effect":"include","host":"a.example.test","ports":[{"from":8080,"to":8080}]}]}`)
	d := Match(Target{Host: str("a.example.test"), Port: num(8080)}, rs)
	require.True(t, d.Allow)
	require.Equal(t, 1, d.MatchedRuleIndex)
}

func TestHugeRuleSetStaysFast(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"rules":[`)
	for i := range RulesMax - 1 {
		fmt.Fprintf(&b, `{"effect":"include","host":"h%d.example.test"},`, i)
	}
	b.WriteString(`{"effect":"exclude","host":"h7.example.test","paths":["/admin/**"]}]}`)
	rs := mustRules(t, b.String())
	require.Equal(t, RulesMax, rs.Len())
	require.True(t, Match(Target{Host: str("h7.example.test"), Path: str("/ok")}, rs).Allow)
	require.False(t, Match(Target{Host: str("h7.example.test"), Path: str("/admin/x")}, rs).Allow)
	require.False(t, Match(Target{Host: str("h5000.example.test")}, rs).Allow)
}

// randomRule builds a random valid rule document fragment over a tiny universe so overlaps are
// frequent.
func randomRule(rng *rand.Rand, effect string) string {
	hosts := []string{"a.example.test", "b.example.test", "*.example.test", "example.test"}
	paths := []string{"/", "/api", "/api/**", "/admin/**", "/files/*.txt"}
	ports := []string{"80", "443", `{"from":8000,"to":8100}`}
	methods := []string{`"GET"`, `"POST"`, `"DELETE"`}
	parts := []string{fmt.Sprintf(`"effect":%q`, effect)}
	if effect == "include" || rng.IntN(2) == 0 {
		switch rng.IntN(3) {
		case 0:
			parts = append(parts, fmt.Sprintf(`"host":%q`, hosts[rng.IntN(len(hosts))]))
		case 1:
			parts = append(parts, `"cidr":"10.0.0.0/8"`)
		default:
			parts = append(parts, fmt.Sprintf(`"host":%q`, hosts[rng.IntN(len(hosts))]), `"cidr":"10.0.0.0/8"`)
		}
	}
	if rng.IntN(2) == 0 {
		parts = append(parts, fmt.Sprintf(`"paths":[%q]`, paths[rng.IntN(len(paths))]))
	}
	if rng.IntN(2) == 0 {
		parts = append(parts, fmt.Sprintf(`"ports":[%s]`, ports[rng.IntN(len(ports))]))
	}
	if rng.IntN(3) == 0 {
		parts = append(parts, fmt.Sprintf(`"methods":[%s]`, methods[rng.IntN(len(methods))]))
	}
	if len(parts) == 1 { // an exclude must constrain something
		parts = append(parts, `"paths":["/api"]`)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func randomTarget(rng *rand.Rand) Target {
	var t Target
	hosts := []string{"a.example.test", "b.example.test", "x.example.test", "example.test", "a.b.example.test"}
	if rng.IntN(5) != 0 {
		t.Host = str(hosts[rng.IntN(len(hosts))])
	}
	if t.Host == nil || rng.IntN(3) == 0 {
		t.IP = str([]string{"10.1.2.3", "11.1.2.3", "::ffff:10.0.0.1"}[rng.IntN(3)])
	}
	if rng.IntN(2) == 0 {
		t.Port = num([]int{80, 443, 8050, 9000}[rng.IntN(4)])
	}
	if rng.IntN(2) == 0 {
		t.Path = str([]string{"/", "/api", "/api/x", "/admin/x", "/files/a.txt", "/api/../admin/x"}[rng.IntN(6)])
	}
	if rng.IntN(2) == 0 {
		t.Method = str([]string{"GET", "post", "DELETE"}[rng.IntN(3)])
	}
	return t
}

// Property: for any rule set and target, (1) an exclude identical to the winning include
// dominates it, (2) adding an identical exclude of every include can only deny, and (3) the
// decision does not depend on rule order.
func TestPropertyExcludeDominatesAndOrderIndependent(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2)) // #nosec G404 -- fixed-seed PRNG: reproducible property-test inputs, not security-sensitive
	for range 3000 {
		n := 1 + rng.IntN(6)
		var docs []string
		for range n {
			docs = append(docs, randomRule(rng, []string{"include", "exclude"}[rng.IntN(2)]))
		}
		target := randomTarget(rng)
		base := Match(target, mustRules(t, `{"rules":[`+strings.Join(docs, ",")+`]}`))

		shuffled := append([]string(nil), docs...)
		rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		require.Equal(t, base.Allow, Match(target, mustRules(t, `{"rules":[`+strings.Join(shuffled, ",")+`]}`)).Allow, "order independence: %v", docs)

		// An exclude identical to an include cancels that include for every target.
		var mirrored []string
		for _, d := range docs {
			mirrored = append(mirrored, d)
			if strings.Contains(d, `"include"`) {
				mirrored = append(mirrored, strings.Replace(d, `"include"`, `"exclude"`, 1))
			}
		}
		require.False(t, Match(target, mustRules(t, `{"rules":[`+strings.Join(mirrored, ",")+`]}`)).Allow, "exclude dominates: %v", docs)
	}
}

func FuzzMatchNeverPanics(f *testing.F) {
	rs, err := ParseRules([]byte(`{"rules":[{"effect":"include","host":"*.example.test","paths":["/api/**"]},{"effect":"exclude","cidr":"10.0.0.0/8"}]}`))
	if err != nil {
		f.Fatal(err)
	}
	f.Add("a.example.test", "10.0.0.1", 443, "/api/../x", "get")
	f.Fuzz(func(_ *testing.T, host, ip string, port int, path, method string) {
		Match(Target{Host: &host, IP: &ip, Port: &port, Path: &path, Method: &method}, rs)
	})
}
