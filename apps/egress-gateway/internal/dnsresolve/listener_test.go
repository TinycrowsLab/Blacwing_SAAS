package dnsresolve_test

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/dnsresolve"
)

func allKeys(net.Addr) (string, bool) { return "run1", true }

// startListener serves the handler on a loopback UDP socket and returns its address.
func startListener(t *testing.T, h *harness, key dnsresolve.KeyFunc) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := &dns.Server{PacketConn: pc, Handler: h.r.Handler(key)}
	started := make(chan struct{})
	srv.NotifyStartedFunc = func() { close(started) }
	go func() { _ = srv.ActivateAndServe() }()
	<-started
	t.Cleanup(func() { _ = srv.Shutdown() })
	return pc.LocalAddr().String()
}

func ask(t *testing.T, addr, name string, qt uint16) *dns.Msg {
	t.Helper()
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qt)
	resp, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, addr)
	require.NoError(t, err)
	return resp
}

func TestListenerAnswersInScopeWithPinnedIP(t *testing.T) {
	up := &fakeUpstream{answers: answers(
		"app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")},
		"app.example.com./A", []dns.RR{a("app.example.com.", "10.0.0.1")},
		"v6.example.com./AAAA", []dns.RR{aaaa("v6.example.com.", "2606:4700:4700::1111")},
	)}
	h := newHarness(t, scope("app.example.com", "v6.example.com"), up)
	addr := startListener(t, h, allKeys)

	for range 2 { // second answer must still be the pinned public IP
		resp := ask(t, addr, "app.example.com", dns.TypeA)
		require.Equal(t, dns.RcodeSuccess, resp.Rcode)
		require.Len(t, resp.Answer, 1)
		a, ok := resp.Answer[0].(*dns.A)
		require.True(t, ok)
		assert.Equal(t, "93.184.216.34", a.A.String())
	}
	// AAAA for a name pinned to IPv4 is NODATA, not a second resolution.
	resp := ask(t, addr, "app.example.com", dns.TypeAAAA)
	assert.Equal(t, dns.RcodeSuccess, resp.Rcode)
	assert.Empty(t, resp.Answer)

	resp = ask(t, addr, "v6.example.com", dns.TypeAAAA)
	require.Len(t, resp.Answer, 1)
	aaaa, ok := resp.Answer[0].(*dns.AAAA)
	require.True(t, ok)
	assert.Equal(t, "2606:4700:4700::1111", aaaa.AAAA.String())
}

func TestListenerRefusesWithoutQueryingUpstream(t *testing.T) {
	up := &fakeUpstream{answers: answers("meta.example.com./A", []dns.RR{a("meta.example.com.", "169.254.169.254")})}
	h := newHarness(t, scope("app.example.com", "meta.example.com"), up)
	addr := startListener(t, h, allKeys)

	assert.Equal(t, dns.RcodeRefused, ask(t, addr, "evil.com", dns.TypeA).Rcode)
	assert.Equal(t, dns.RcodeRefused, ask(t, addr, "evil.com", dns.TypeAAAA).Rcode)
	assert.Equal(t, dns.RcodeRefused, ask(t, addr, "app.example.com", dns.TypeTXT).Rcode, "only A/AAAA are answered")
	assert.Equal(t, dns.RcodeRefused, ask(t, addr, "app.example.com", dns.TypeANY).Rcode)
	assert.Zero(t, up.count(), "refused queries never reach the upstream")

	assert.Equal(t, dns.RcodeRefused, ask(t, addr, "meta.example.com", dns.TypeA).Rcode, "metadata IP via a name is refused")
}

func TestListenerRefusesUnknownClientAndServfailsOnUpstreamError(t *testing.T) {
	h := newHarness(t, scope("app.example.com"), &fakeUpstream{err: assert.AnError})
	unknown := startListener(t, h, func(net.Addr) (string, bool) { return "", false })
	assert.Equal(t, dns.RcodeRefused, ask(t, unknown, "app.example.com", dns.TypeA).Rcode)

	known := startListener(t, h, allKeys)
	assert.Equal(t, dns.RcodeServerFailure, ask(t, known, "app.example.com", dns.TypeA).Rcode)
}

func TestServeAnswersOverUDPAndTCPAndStopsOnCancel(t *testing.T) {
	up := &fakeUpstream{answers: answers("app.example.com./A", []dns.RR{a("app.example.com.", "93.184.216.34")})}
	h := newHarness(t, scope("app.example.com"), up)

	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.r.Serve(ctx, addr, allKeys) }()

	require.Eventually(t, func() bool {
		m := new(dns.Msg)
		m.SetQuestion("app.example.com.", dns.TypeA)
		r, _, err := (&dns.Client{Net: "tcp", Timeout: time.Second}).Exchange(m, addr)
		return err == nil && len(r.Answer) == 1
	}, 5*time.Second, 50*time.Millisecond)
	resp := ask(t, addr, "app.example.com", dns.TypeA)
	require.Len(t, resp.Answer, 1)

	cancel()
	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not stop on cancel")
	}
}
