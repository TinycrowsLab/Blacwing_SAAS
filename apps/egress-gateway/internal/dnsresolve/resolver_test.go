package dnsresolve_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/dnsresolve"
)

// fakeScope allows exact hostnames, hosts under a suffix and explicit IPs/CIDRs.
type fakeScope struct {
	hosts    map[string]bool
	prefixes []netip.Prefix
}

func (s fakeScope) HostInScope(h string) bool { return s.hosts[h] }
func (s fakeScope) IPInScope(ip netip.Addr) bool {
	for _, p := range s.prefixes {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func scope(hosts ...string) fakeScope {
	m := map[string]bool{}
	for _, h := range hosts {
		m[h] = true
	}
	return fakeScope{hosts: m}
}

// fakeUpstream answers from a table; each name's answers are consumed in order and
// the last one repeats, so a test can script a rebinding sequence.
type fakeUpstream struct {
	mu      sync.Mutex
	answers map[string][][]dns.RR // "name/TYPE" -> sequence of answer sets
	rcode   int
	err     error
	queried []string
}

func (f *fakeUpstream) ExchangeContext(_ context.Context, m *dns.Msg, _ string) (*dns.Msg, time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := m.Question[0]
	key := q.Name + "/" + dns.TypeToString[q.Qtype]
	f.queried = append(f.queried, key)
	if f.err != nil {
		return nil, 0, f.err
	}
	r := new(dns.Msg)
	r.SetReply(m)
	r.Rcode = f.rcode
	if seq := f.answers[key]; len(seq) > 0 {
		r.Answer = seq[0]
		if len(seq) > 1 {
			f.answers[key] = seq[1:]
		}
	}
	return r, 0, nil
}

func (f *fakeUpstream) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.queried)
}

func a(name, ip string) dns.RR {
	return &dns.A{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 0}, A: net.ParseIP(ip)}
}
func aaaa(name, ip string) dns.RR {
	return &dns.AAAA{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: 0}, AAAA: net.ParseIP(ip)}
}
func cname(name, target string) dns.RR {
	return &dns.CNAME{Hdr: dns.RR_Header{Name: name, Rrtype: dns.TypeCNAME, Class: dns.ClassINET}, Target: target}
}
func answers(kv ...any) map[string][][]dns.RR {
	m := map[string][][]dns.RR{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i].(string)] = append(m[kv[i].(string)], kv[i+1].([]dns.RR))
	}
	return m
}

type recordingAudit struct {
	mu     sync.Mutex
	events []dnsresolve.BlockedEvent
}

func (r *recordingAudit) DNSBlocked(_ context.Context, ev dnsresolve.BlockedEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	return nil
}

type harness struct {
	r     *dnsresolve.Resolver
	up    *fakeUpstream
	audit *recordingAudit
	reg   *prometheus.Registry
	now   *time.Time
}

func newHarness(t *testing.T, sc fakeScope, up *fakeUpstream, mutate ...func(*dnsresolve.Options)) *harness {
	t.Helper()
	now := time.Unix(1_700_000_000, 0)
	h := &harness{up: up, audit: &recordingAudit{}, reg: prometheus.NewRegistry(), now: &now}
	opts := dnsresolve.Options{
		Scope: sc, Upstream: "192.0.2.53:53", PinTTL: 2 * time.Minute, StrictCNAME: true,
		Exchanger: up, Audit: h.audit, Metrics: dnsresolve.NewMetrics(h.reg), Now: func() time.Time { return *h.now },
	}
	for _, f := range mutate {
		f(&opts)
	}
	r, err := dnsresolve.New(opts)
	require.NoError(t, err)
	h.r = r
	return h
}

func TestResolvePinsAndReusesWithinTTL(t *testing.T) {
	up := &fakeUpstream{answers: answers("app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")})}
	h := newHarness(t, scope("app.example.com"), up)

	ip, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", ip.String())
	queries := up.count()

	ip2, err := h.r.Resolve(context.Background(), "APP.example.com.", "run1")
	require.NoError(t, err)
	assert.True(t, ip.Equal(ip2))
	assert.Equal(t, queries, up.count(), "second resolution must not query upstream")
	require.NoError(t, testutil.GatherAndCompare(h.reg, strings.NewReader(`
# HELP egress_dns_pin_hits_total Resolutions answered from an existing pin.
# TYPE egress_dns_pin_hits_total counter
egress_dns_pin_hits_total 1
`), "egress_dns_pin_hits_total"))
}

func TestRebindingKeepsFirstPinnedIP(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")},
		"app.example.com./A", []dns.RR{a("app.example.com.", "169.254.169.254")},
	)}
	h := newHarness(t, scope("app.example.com"), up)
	first, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
	require.NoError(t, err)

	for range 3 {
		again, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
		require.NoError(t, err)
		assert.True(t, first.Equal(again), "pin must hold while upstream rebinds to a private IP")
	}
}

func TestPinExpiresAfterTTLAndReresolves(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")},
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.35")},
	)}
	h := newHarness(t, scope("app.example.com"), up)
	first, _ := h.r.Resolve(context.Background(), "app.example.com", "run1")
	*h.now = h.now.Add(2*time.Minute + time.Second)
	second, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", first.String())
	assert.Equal(t, "93.184.216.35", second.String())
}

func TestPinsAreIsolatedPerKeyAndReleased(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")},
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.35")},
	)}
	h := newHarness(t, scope("app.example.com"), up)
	one, _ := h.r.Resolve(context.Background(), "app.example.com", "run1")
	two, err := h.r.Resolve(context.Background(), "app.example.com", "run2")
	require.NoError(t, err)
	assert.False(t, one.Equal(two), "run2 must not read run1's pin")

	h.r.Release("run1")
	again, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.35", again.String(), "released key resolves afresh")
}

func TestOutOfScopeHostMakesNoUpstreamQuery(t *testing.T) {
	up := &fakeUpstream{answers: answers()}
	h := newHarness(t, scope("app.example.com"), up)
	for _, host := range []string{"evil.com", "", " ", "bad_name\x00.com", "xn--.com"} {
		_, err := h.r.Resolve(context.Background(), host, "run1")
		assert.ErrorIs(t, err, dnsresolve.ErrHostOutOfScope, host)
	}
	assert.Zero(t, up.count())
	require.NotEmpty(t, h.audit.events)
	assert.Equal(t, dnsresolve.ReasonOutOfScope, h.audit.events[0].Reason)
	assert.Empty(t, h.audit.events[0].IPHash)
}

func TestBlockedRangesAreRefusedForIPv4AndIPv6(t *testing.T) {
	for _, ip := range []string{
		"10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.1.1", "224.0.0.1",
		"::1", "fd00:ec2::254", "fe80::1", "::ffff:10.0.0.5",
	} {
		t.Run(ip, func(t *testing.T) {
			key := "app.example.com./A"
			rr := a("app.example.com.", ip)
			if net.ParseIP(ip).To4() == nil {
				key, rr = "app.example.com./AAAA", aaaa("app.example.com.", ip)
			}
			up := &fakeUpstream{answers: answers(key, []dns.RR{rr})}
			h := newHarness(t, scope("app.example.com"), up)
			_, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
			assert.ErrorIs(t, err, dnsresolve.ErrBlockedRange)
			require.Len(t, h.audit.events, 1)
			assert.Equal(t, dnsresolve.ReasonBlockedRange, h.audit.events[0].Reason)
			assert.Len(t, h.audit.events[0].IPHash, 16)
			require.NoError(t, testutil.GatherAndCompare(h.reg, strings.NewReader(`
# HELP egress_dns_blocked_total Blocked DNS resolutions by reason: host_out_of_scope, cname_out_of_scope, blocked_range.
# TYPE egress_dns_blocked_total counter
egress_dns_blocked_total{reason="blocked_range"} 1
`), "egress_dns_blocked_total"))
			assert.NotContains(t, h.audit.events[0].IPHash, ip)
		})
	}
}

func TestBlockedRangeAllowedWhenIPExplicitlyInScope(t *testing.T) {
	up := &fakeUpstream{answers: answers("lab.example.com./A", []dns.RR{a("lab.example.com.", "10.1.2.3")})}
	sc := scope("lab.example.com")
	sc.prefixes = []netip.Prefix{netip.MustParsePrefix("10.1.2.0/24")}
	h := newHarness(t, sc, up)
	ip, err := h.r.Resolve(context.Background(), "lab.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "10.1.2.3", ip.String())

	// A different private IP outside the explicit CIDR stays blocked.
	up2 := &fakeUpstream{answers: answers("lab.example.com./A", []dns.RR{a("lab.example.com.", "10.9.9.9")})}
	h2 := newHarness(t, sc, up2)
	_, err = h2.r.Resolve(context.Background(), "lab.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrBlockedRange)
}

func TestMultipleRecordsPickDeterministicallyAndPreferIPv4(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.40"), a("app.example.com.", "93.184.216.9")},
		"app.example.com./AAAA", []dns.RR{aaaa("app.example.com.", "2606:4700::1")},
	)}
	h := newHarness(t, scope("app.example.com"), up)
	ip, err := h.r.Resolve(context.Background(), "app.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.9", ip.String())
}

func TestIPv6OnlyNamePins(t *testing.T) {
	up := &fakeUpstream{answers: answers("v6.example.com./AAAA", []dns.RR{aaaa("v6.example.com.", "2606:4700:4700::1111")})}
	h := newHarness(t, scope("v6.example.com"), up)
	ip, err := h.r.Resolve(context.Background(), "v6.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "2606:4700:4700::1111", ip.String())
}

func TestCNAMEChainFinalIPValidated(t *testing.T) {
	up := &fakeUpstream{answers: answers("a.example.com./A", []dns.RR{
		cname("a.example.com.", "b.example.com."), a("b.example.com.", "10.0.0.7"),
	})}
	h := newHarness(t, scope("a.example.com", "b.example.com"), up)
	_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrBlockedRange)
}

func TestCNAMEToOutOfScopeNameBlockedWhenStrict(t *testing.T) {
	up := &fakeUpstream{answers: answers("a.example.com./A", []dns.RR{
		cname("a.example.com.", "evil.com."), a("evil.com.", "93.184.216.34"),
	})}
	h := newHarness(t, scope("a.example.com"), up)
	_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrHostOutOfScope)
	require.Len(t, h.audit.events, 1)
	assert.Equal(t, dnsresolve.ReasonCNAMEScope, h.audit.events[0].Reason)

	// Not strict: the out-of-scope intermediate is tolerated, the final IP is checked.
	h2 := newHarness(t, scope("a.example.com"), up, func(o *dnsresolve.Options) { o.StrictCNAME = false })
	ip, err := h2.r.Resolve(context.Background(), "a.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", ip.String())
}

func TestCNAMEFollowedByRequeryWhenAnswerHasNoAddresses(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"a.example.com./A", []dns.RR{cname("a.example.com.", "b.example.com.")},
		"b.example.com./A", []dns.RR{a("b.example.com.", "93.184.216.34")},
	)}
	h := newHarness(t, scope("a.example.com", "b.example.com"), up)
	ip, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", ip.String())
}

func TestUnrelatedRecordsInAnswerAreIgnored(t *testing.T) {
	// A poisoned answer carrying an address for another name must not be used.
	up := &fakeUpstream{answers: answers("a.example.com./A", []dns.RR{
		a("other.example.org.", "93.184.216.99"),
	})}
	h := newHarness(t, scope("a.example.com"), up)
	_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrResolveFailed)
}

func TestCNAMELoopAndOverlongChainFail(t *testing.T) {
	loop := &fakeUpstream{answers: answers("a.example.com./A", []dns.RR{
		cname("a.example.com.", "b.example.com."), cname("b.example.com.", "a.example.com."),
	})}
	h := newHarness(t, scope("a.example.com", "b.example.com"), loop)
	_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrResolveFailed)
}

func TestUpstreamFailuresFailClosed(t *testing.T) {
	sc := scope("a.example.com")
	h := newHarness(t, sc, &fakeUpstream{err: errors.New("i/o timeout")})
	_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrResolveFailed)

	for _, rc := range []int{dns.RcodeServerFailure, dns.RcodeNameError, dns.RcodeRefused} {
		h := newHarness(t, sc, &fakeUpstream{rcode: rc})
		_, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
		assert.ErrorIs(t, err, dnsresolve.ErrResolveFailed, dns.RcodeToString[rc])
	}
	h = newHarness(t, sc, &fakeUpstream{}) // NOERROR, no records
	_, err = h.r.Resolve(context.Background(), "a.example.com", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrResolveFailed)
}

func TestLowUpstreamTTLStillHonoursPin(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"a.example.com./A", []dns.RR{a("a.example.com.", "93.184.216.34")}, // Ttl 0
		"a.example.com./A", []dns.RR{a("a.example.com.", "93.184.216.35")},
	)}
	h := newHarness(t, scope("a.example.com"), up)
	first, _ := h.r.Resolve(context.Background(), "a.example.com", "run1")
	*h.now = h.now.Add(time.Minute)
	second, err := h.r.Resolve(context.Background(), "a.example.com", "run1")
	require.NoError(t, err)
	assert.True(t, first.Equal(second))
}

func TestIDNIsNormalisedBeforeScopeCheck(t *testing.T) {
	up := &fakeUpstream{answers: answers("xn--bcher-kva.example.com./A", []dns.RR{a("xn--bcher-kva.example.com.", "93.184.216.34")})}
	h := newHarness(t, scope("xn--bcher-kva.example.com"), up)
	ip, err := h.r.Resolve(context.Background(), "Bücher.example.com", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", ip.String())
}

func TestIPLiteralIsScopeAndRangeChecked(t *testing.T) {
	up := &fakeUpstream{answers: answers()}
	h := newHarness(t, scope("93.184.216.34", "169.254.169.254"), up)
	ip, err := h.r.Resolve(context.Background(), "93.184.216.34", "run1")
	require.NoError(t, err)
	assert.Equal(t, "93.184.216.34", ip.String())
	_, err = h.r.Resolve(context.Background(), "169.254.169.254", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrBlockedRange, "scope on the name does not unblock a metadata IP")
	_, err = h.r.Resolve(context.Background(), "8.8.8.8", "run1")
	assert.ErrorIs(t, err, dnsresolve.ErrHostOutOfScope)
	assert.Zero(t, up.count(), "literals are never sent upstream")
}

func TestMetricsAndLogs(t *testing.T) {
	var buf bytes.Buffer
	up := &fakeUpstream{answers: answers("a.example.com./A", []dns.RR{a("a.example.com.", "93.184.216.34")})}
	h := newHarness(t, scope("a.example.com"), up, func(o *dnsresolve.Options) {
		o.Logger = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		o.Audit = nil
	})
	_, _ = h.r.Resolve(context.Background(), "a.example.com", "k")
	_, _ = h.r.Resolve(context.Background(), "evil.com", "k")
	assert.Contains(t, buf.String(), `"component":"dns"`)
	assert.Contains(t, buf.String(), `"pinned_ip":"93.184.216.34"`)
	assert.Contains(t, buf.String(), `"event":"egress.dns_blocked"`)
	assert.Contains(t, buf.String(), `"component":"audit"`)
}

func TestNewValidatesOptions(t *testing.T) {
	_, err := dnsresolve.New(dnsresolve.Options{PinTTL: time.Second, Upstream: "x:53"})
	assert.Error(t, err)
	_, err = dnsresolve.New(dnsresolve.Options{Scope: scope(), Upstream: "x:53"})
	assert.Error(t, err)
}
