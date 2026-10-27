package httpproxy

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/elazarl/goproxy"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/server"
)

const goodToken = "tok-live-0123456789"

type fakeGate struct{ ready atomic.Bool }

func (g *fakeGate) Ready() bool { return g.ready.Load() }

// scopeAuthorizer allows requests whose host is in allow and records every request.
type scopeAuthorizer struct {
	allow map[string]bool
	mu    sync.Mutex
	seen  []Request
}

func (a *scopeAuthorizer) Authorize(_ context.Context, r Request) Decision {
	a.mu.Lock()
	a.seen = append(a.seen, r)
	a.mu.Unlock()
	if a.allow[r.Host] {
		return Decision{Allow: true, MatchedRule: "scope:allow-lab"}
	}
	return Decision{Code: "out_of_scope", Reason: "target host is not in scope", MatchedRule: "scope:default-deny"}
}

type recordingAuditor struct {
	mu     sync.Mutex
	events []DeniedEvent
}

func (a *recordingAuditor) RequestDenied(_ context.Context, ev DeniedEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, ev)
	return nil
}

type fixture struct {
	t        *testing.T
	plane    *Plane
	gate     *fakeGate
	authz    *scopeAuthorizer
	audit    *recordingAuditor
	reg      *prometheus.Registry
	dials    atomic.Int32
	user     string
	runID    uuid.UUID
	testCase uuid.UUID
}

type option func(*Options, *fixture)

func newFixture(t *testing.T, mods ...option) *fixture {
	t.Helper()
	f := &fixture{t: t, gate: &fakeGate{}, audit: &recordingAuditor{}, reg: prometheus.NewRegistry()}
	f.gate.ready.Store(true)
	f.runID, f.testCase = uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	session := uuid.Must(uuid.NewV7())
	f.user = fmt.Sprintf("tc_%s.sess_%s.run_%s", f.testCase, session, f.runID)

	v := &identity.StaticVerifier{}
	v.Add(goodToken, identity.TokenClaims{RunID: f.runID, SessionID: session, ExpiresAt: time.Now().Add(time.Hour)})
	auth, err := identity.NewAuthenticator(identity.Options{Verifier: v})
	require.NoError(t, err)

	f.authz = &scopeAuthorizer{allow: map[string]bool{"127.0.0.1": true}}
	opts := Options{
		Addr: "127.0.0.1:0", ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second,
		IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8 << 10, UpstreamTimeout: 2 * time.Second,
		Auth: auth, Authorizer: f.authz, Audit: f.audit, Registerer: f.reg,
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			f.dials.Add(1)
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		},
	}
	for _, m := range mods {
		m(&opts, f)
	}
	f.plane, err = New(opts)
	require.NoError(t, err)
	require.NoError(t, f.plane.Start(context.Background(), f.gate, server.Hooks{}))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = f.plane.Shutdown(ctx)
	})
	return f
}

func basicAuth(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func (f *fixture) auth() string { return basicAuth(f.user, goodToken) }

// raw sends a literal request and returns the parsed response (body read and closed).
func (f *fixture) raw(request string) (*http.Response, string) {
	f.t.Helper()
	c, err := net.Dial("tcp", f.plane.Addr().String())
	require.NoError(f.t, err)
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = io.WriteString(c, request)
	require.NoError(f.t, err)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	require.NoError(f.t, err)
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, string(body)
}

func (f *fixture) get(url string, headers ...string) (*http.Response, string) {
	f.t.Helper()
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: ignored.example\r\nProxy-Authorization: %s\r\n", url, f.auth())
	for _, h := range headers {
		req += h + "\r\n"
	}
	return f.raw(req + "Connection: close\r\n\r\n")
}

type upstream struct {
	*httptest.Server
	mu      sync.Mutex
	hits    int
	headers http.Header
	host    string
	remotes []string
}

func newUpstream(t *testing.T) *upstream {
	t.Helper()
	u := &upstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.hits++
		u.headers, u.host = r.Header.Clone(), r.Host
		u.remotes = append(u.remotes, r.RemoteAddr)
		u.mu.Unlock()
		w.Header().Set("X-Upstream", "yes")
		w.Header().Set("Keep-Alive", "timeout=5")
		_, _ = io.WriteString(w, "hello from upstream")
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *upstream) hitCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.hits
}

func decodeProblem(t *testing.T, body string) problem {
	t.Helper()
	var p problem
	require.NoError(t, json.Unmarshal([]byte(body), &p), body)
	return p
}

func TestForwardsAllowedRequest(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)

	resp, body := f.get(up.URL+"/path?q=1",
		"Keep-Alive: 300", "Proxy-Connection: keep-alive", "X-Hop: secret", "Connection: X-Hop", "TE: trailers",
		"Via: 1.1 internal-proxy")
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "hello from upstream", body)
	assert.Equal(t, "yes", resp.Header.Get("X-Upstream"))

	require.Equal(t, 1, up.hitCount())
	for _, h := range []string{"Proxy-Authorization", "Proxy-Connection", "Keep-Alive", "X-Hop", "Te"} {
		assert.Empty(t, up.headers.Get(h), "%s must not reach the origin", h)
	}
	assert.Empty(t, up.headers.Get("X-Forwarded-For"), "no X-Forwarded-* topology leak")
	assert.Empty(t, up.headers.Get("Forwarded"))
	assert.Equal(t, strings.TrimPrefix(up.URL, "http://"), up.host, "the URL, not the client Host header, names the origin")
	assert.Empty(t, resp.Header.Get("Keep-Alive"), "hop-by-hop response header stripped")

	require.Len(t, f.authz.seen, 1)
	got := f.authz.seen[0]
	assert.Equal(t, "http:GET", got.Action)
	assert.Equal(t, "http", got.Scheme)
	assert.Equal(t, "127.0.0.1", got.Host)
	assert.NotZero(t, got.Port)
	assert.Equal(t, f.testCase, got.Identity.TestCaseID)
	assert.Equal(t, f.runID, got.Identity.RunID)
	assert.Contains(t, got.URL, "/path?q=1")
	assert.InDelta(t, 1, testutil.ToFloat64(f.plane.met.requests.WithLabelValues("allow", "GET")), 0)
}

func TestProxyAuthRequired(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)
	target := up.URL + "/"
	cases := map[string]string{
		"missing":      fmt.Sprintf("GET %s HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", target),
		"bad token":    fmt.Sprintf("GET %s HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\nConnection: close\r\n\r\n", target, basicAuth(f.user, "wrong-token")),
		"bad scheme":   fmt.Sprintf("GET %s HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Bearer abc\r\nConnection: close\r\n\r\n", target),
		"bad identity": fmt.Sprintf("GET %s HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\nConnection: close\r\n\r\n", target, basicAuth("nobody", goodToken)),
		// The body must not be read: the claimed length is far beyond what is sent.
		"body before auth": fmt.Sprintf("POST %s HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\npartial", target),
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			resp, _ := f.raw(req)
			assert.Equal(t, http.StatusProxyAuthRequired, resp.StatusCode)
			assert.True(t, strings.HasPrefix(resp.Header.Get("Proxy-Authenticate"), `Basic realm="blackwing-egress"`))
			assert.True(t, resp.Close)
		})
	}
	assert.Zero(t, up.hitCount())
	assert.Zero(t, f.dials.Load(), "no upstream socket on auth failure")
	assert.Empty(t, f.authz.seen, "policy is not consulted for unauthenticated requests")
}

func TestOutOfScopeIsDeniedWithoutDialing(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t, func(_ *Options, f *fixture) { f.authz.allow = map[string]bool{} })

	resp, body := f.get(up.URL + "/secret")
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Equal(t, "application/problem+json", resp.Header.Get("Content-Type"))
	p := decodeProblem(t, body)
	assert.Equal(t, "out_of_scope", p.Code)
	assert.Equal(t, "scope:default-deny", p.MatchedRule)
	assert.NotEmpty(t, p.Reason)

	assert.Zero(t, up.hitCount(), "sentinel upstream was never contacted")
	assert.Zero(t, f.dials.Load(), "no upstream socket opened")
	require.Len(t, f.audit.events, 1)
	ev := f.audit.events[0]
	assert.Equal(t, "egress.request_denied", ev.Type)
	assert.Equal(t, "scope:default-deny", ev.MatchedRule)
	assert.Equal(t, f.runID.String(), ev.RunID)
	assert.Equal(t, f.testCase.String(), ev.TestCaseID)
	assert.Equal(t, "127.0.0.1", ev.TargetHost)
	assert.InDelta(t, 1, testutil.ToFloat64(f.plane.met.requests.WithLabelValues("deny", "GET")), 0)
}

func TestDefaultAuthorizerDeniesEverything(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t, func(o *Options, _ *fixture) { o.Authorizer = nil })
	resp, body := f.get(up.URL + "/")
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Equal(t, "policy_unavailable", decodeProblem(t, body).Code)
	assert.Zero(t, f.dials.Load())
}

func TestConnectTunnel(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = echo.Close() }()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer func() { _ = c.Close() }(); _, _ = io.Copy(c, c) }()
		}
	}()
	echoAddr := echo.Addr().String()
	_, echoPort, _ := net.SplitHostPort(echoAddr)
	var portNum int
	_, _ = fmt.Sscan(echoPort, &portNum)

	f := newFixture(t, func(o *Options, _ *fixture) {
		o.AllowRawTunnel = true
		o.MITMEnabled = false
		o.ConnectPorts = []int{portNum}
	})

	connect := func(authority, authHeader string) (*http.Response, net.Conn, *bufio.Reader) {
		c, err := net.Dial("tcp", f.plane.Addr().String())
		require.NoError(t, err)
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", authority, authority)
		if authHeader != "" {
			req += "Proxy-Authorization: " + authHeader + "\r\n"
		}
		_, err = io.WriteString(c, req+"\r\n")
		require.NoError(t, err)
		br := bufio.NewReader(c)
		resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
		require.NoError(t, err)
		return resp, c, br
	}

	t.Run("in scope establishes a tunnel", func(t *testing.T) {
		resp, c, br := connect(echoAddr, f.auth())
		defer func() { _ = c.Close() }()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		_, err := io.WriteString(c, "ping")
		require.NoError(t, err)
		buf := make([]byte, 4)
		_, err = io.ReadFull(br, buf)
		require.NoError(t, err)
		assert.Equal(t, "ping", string(buf))
		last := f.authz.seen[len(f.authz.seen)-1]
		assert.Equal(t, "http:CONNECT", last.Action)
		assert.Equal(t, "https", last.Scheme)
		assert.Equal(t, portNum, last.Port)
	})

	t.Run("out of scope host is 403 and not dialed", func(t *testing.T) {
		before := f.dials.Load()
		f.authz.allow = map[string]bool{}
		defer func() { f.authz.allow = map[string]bool{"127.0.0.1": true} }()
		resp, c, _ := connect(echoAddr, f.auth())
		defer func() { _ = c.Close() }()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, "scope:default-deny", decodeProblem(t, string(body)).MatchedRule)
		assert.Equal(t, before, f.dials.Load())
	})

	t.Run("missing auth is 407", func(t *testing.T) {
		before := f.dials.Load()
		resp, c, _ := connect(echoAddr, "")
		defer func() { _ = c.Close() }()
		assert.Equal(t, http.StatusProxyAuthRequired, resp.StatusCode)
		assert.True(t, strings.HasPrefix(resp.Header.Get("Proxy-Authenticate"), `Basic realm="blackwing-egress"`))
		assert.Equal(t, before, f.dials.Load())
	})

	t.Run("disallowed port is 403 before policy", func(t *testing.T) {
		seen := len(f.authz.seen)
		resp, c, _ := connect("127.0.0.1:22", f.auth())
		defer func() { _ = c.Close() }()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
		body, _ := io.ReadAll(resp.Body)
		assert.Equal(t, "port_not_allowed", decodeProblem(t, string(body)).Code)
		assert.Len(t, f.authz.seen, seen)
	})

	t.Run("authority without port is 400", func(t *testing.T) {
		resp, c, _ := connect("localhost", f.auth())
		defer func() { _ = c.Close() }()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	})
}

func TestConnectInterceptionModes(t *testing.T) {
	t.Run("MITM enabled without a hook refuses the tunnel", func(t *testing.T) {
		f := newFixture(t, func(o *Options, _ *fixture) { o.MITMEnabled = true })
		resp, body := f.raw(fmt.Sprintf("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\n\r\n", f.auth()))
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Equal(t, "interception_unavailable", decodeProblem(t, body).Code)
		assert.Zero(t, f.dials.Load())
	})
	t.Run("MITM hook receives the authorised connect", func(t *testing.T) {
		hook := &recordingInterceptor{}
		f := newFixture(t, func(o *Options, _ *fixture) { o.MITMEnabled = true; o.MITM = hook })
		// The hook rejects, so the test needs no TLS machinery: it proves hand-off only.
		c, err := net.Dial("tcp", f.plane.Addr().String())
		require.NoError(t, err)
		defer func() { _ = c.Close() }()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		_, err = fmt.Fprintf(c, "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\n\r\n", f.auth())
		require.NoError(t, err)
		_, _ = io.Copy(io.Discard, c) // the rejecting hook closes the connection
		hosts, ids := hook.calls()
		require.Len(t, hosts, 1)
		assert.Equal(t, "127.0.0.1:443", hosts[0])
		assert.Equal(t, f.testCase, ids[0].TestCaseID)
	})
	t.Run("MITM disabled does not fall back to a raw tunnel", func(t *testing.T) {
		f := newFixture(t, func(o *Options, _ *fixture) { o.MITMEnabled = false; o.MITM = &recordingInterceptor{} })
		resp, _ := f.raw(fmt.Sprintf("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\n\r\n", f.auth()))
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Zero(t, f.dials.Load())
	})
}

type recordingInterceptor struct {
	mu    sync.Mutex
	hosts []string
	ids   []identity.RequestIdentity
}

func (r *recordingInterceptor) calls() ([]string, []identity.RequestIdentity) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.hosts...), append([]identity.RequestIdentity(nil), r.ids...)
}

func (r *recordingInterceptor) Intercept(id identity.RequestIdentity, host string) *goproxy.ConnectAction {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hosts, r.ids = append(r.hosts, host), append(r.ids, id)
	return &goproxy.ConnectAction{Action: goproxy.ConnectReject}
}

func TestDeniesUnsupportedRequests(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)
	auth := "Proxy-Authorization: " + f.auth() + "\r\n"
	target := up.URL + "/"
	cases := map[string]struct {
		req    string
		status int
		code   string
	}{
		"unknown method":    {"BREW " + target + " HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: close\r\n\r\n", 403, "method_not_allowed"},
		"h2c upgrade":       {"GET " + target + " HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n", 403, "upgrade_not_supported"},
		"websocket":         {"GET " + target + " HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n", 403, "upgrade_not_supported"},
		"https absolute":    {"GET https://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: close\r\n\r\n", 400, "invalid_target"},
		"userinfo in url":   {"GET http://user:pw@127.0.0.1/ HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: close\r\n\r\n", 400, "invalid_target"},
		"port out of range": {"GET http://127.0.0.1:70000/ HTTP/1.1\r\nHost: x\r\n" + auth + "Connection: close\r\n\r\n", 400, "invalid_target"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp, body := f.raw(tc.req)
			assert.Equal(t, tc.status, resp.StatusCode)
			assert.Equal(t, tc.code, decodeProblem(t, body).Code)
		})
	}
	assert.Zero(t, up.hitCount())
	assert.Zero(t, f.dials.Load())
	assert.Empty(t, f.authz.seen, "syntactic denials never reach policy")
}

func TestNonProxyAndMalformedRequests(t *testing.T) {
	f := newFixture(t)
	resp, _ := f.raw("GET /relative HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)

	resp, _ = f.raw("NOT A REQUEST LINE\r\n\r\n")
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)

	resp, _ = f.raw("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
	assert.GreaterOrEqual(t, resp.StatusCode, 400, "HTTP/2 prior knowledge is refused")
	assert.Zero(t, f.dials.Load())
}

func TestOversizedHeadersAreRejectedAndClosed(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)
	resp, _ := f.raw(fmt.Sprintf("GET %s/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\nX-Big: %s\r\n\r\n",
		up.URL, f.auth(), strings.Repeat("a", 16<<10)))
	assert.GreaterOrEqual(t, resp.StatusCode, 400)
	assert.Less(t, resp.StatusCode, 500)
	assert.True(t, resp.Close, "connection closed")
	assert.Zero(t, f.dials.Load())
}

func TestSlowHeadersAreCutOffByReadTimeout(t *testing.T) {
	f := newFixture(t, func(o *Options, _ *fixture) { o.ReadTimeout = 200 * time.Millisecond })
	c, err := net.Dial("tcp", f.plane.Addr().String())
	require.NoError(t, err)
	defer func() { _ = c.Close() }()
	_, _ = io.WriteString(c, "GET http://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n") // never finishes
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	start := time.Now()
	_, err = io.ReadAll(c)
	require.NoError(t, err, "server closes the connection rather than the test timing out")
	assert.Less(t, time.Since(start), 2*time.Second)
}

func TestListenerTimeoutsComeFromOptions(t *testing.T) {
	f := newFixture(t, func(o *Options, _ *fixture) {
		o.ReadTimeout, o.WriteTimeout, o.IdleTimeout, o.MaxHeaderBytes = 3*time.Second, 4*time.Second, 5*time.Second, 2048
	})
	srv := f.plane.srv
	assert.Equal(t, 3*time.Second, srv.ReadTimeout)
	assert.Equal(t, 3*time.Second, srv.ReadHeaderTimeout)
	assert.Equal(t, 4*time.Second, srv.WriteTimeout)
	assert.Equal(t, 5*time.Second, srv.IdleTimeout)
	assert.Equal(t, 2048, srv.MaxHeaderBytes)
	assert.NotNil(t, srv.TLSNextProto, "HTTP/2 stays disabled")
}

func TestUpstreamFailuresAreMappedAndCounted(t *testing.T) {
	t.Run("refused is 502", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		require.NoError(t, err)
		addr := ln.Addr().String()
		require.NoError(t, ln.Close())
		f := newFixture(t)
		resp, body := f.get("http://" + addr + "/")
		assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
		assert.Equal(t, "upstream_refused", decodeProblem(t, body).Code)
		assert.NotContains(t, body, addr, "dial errors are not echoed")
		assert.InDelta(t, 1, testutil.ToFloat64(f.plane.met.upstream.WithLabelValues("refused")), 0)
		assert.EqualValues(t, 1, f.dials.Load(), "not retried")
	})
	t.Run("slow upstream is 504", func(t *testing.T) {
		slow := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { time.Sleep(time.Second) }))
		defer slow.Close()
		f := newFixture(t, func(o *Options, _ *fixture) { o.UpstreamTimeout = 100 * time.Millisecond })
		resp, body := f.get(slow.URL + "/")
		assert.Equal(t, http.StatusGatewayTimeout, resp.StatusCode)
		assert.Equal(t, "upstream_timeout", decodeProblem(t, body).Code)
		assert.InDelta(t, 1, testutil.ToFloat64(f.plane.met.upstream.WithLabelValues("timeout")), 0)
	})
}

func TestHooksAreCalledAndFailClosed(t *testing.T) {
	up := newUpstream(t)

	t.Run("allowed requests run budget, injector and capture", func(t *testing.T) {
		h := &hookRecorder{}
		f := newFixture(t, func(o *Options, _ *fixture) { o.Budget, o.Sessions, o.Capture = h, h, h })
		resp, _ := f.raw(fmt.Sprintf("POST %s/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello", up.URL, f.auth()))
		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, []int64{5}, h.budget)
		assert.Equal(t, 1, h.injected)
		assert.Equal(t, 1, h.pairs)
		assert.Equal(t, "injected", up.headers.Get("X-Injected"))
		assert.Equal(t, 200, h.lastStatus)
	})
	t.Run("budget exhausted is 429 without dialing", func(t *testing.T) {
		h := &hookRecorder{budgetErr: errors.New("over budget")}
		f := newFixture(t, func(o *Options, _ *fixture) { o.Budget = h })
		resp, body := f.get(up.URL + "/")
		assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
		assert.Equal(t, "budget_exceeded", decodeProblem(t, body).Code)
		assert.Zero(t, f.dials.Load())
		assert.Len(t, f.audit.events, 1)
	})
	t.Run("injection failure is 503 without dialing", func(t *testing.T) {
		h := &hookRecorder{injectErr: errors.New("no session")}
		f := newFixture(t, func(o *Options, _ *fixture) { o.Sessions = h })
		resp, body := f.get(up.URL + "/")
		assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
		assert.Equal(t, "session_injection_failed", decodeProblem(t, body).Code)
		assert.Zero(t, f.dials.Load())
	})
	t.Run("capture failure withholds the response", func(t *testing.T) {
		h := &hookRecorder{captureErr: errors.New("evidence store down")}
		f := newFixture(t, func(o *Options, _ *fixture) { o.Capture = h })
		resp, body := f.get(up.URL + "/")
		assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
		assert.Equal(t, "capture_failed", decodeProblem(t, body).Code)
		assert.NotContains(t, body, "hello from upstream")
	})
	t.Run("denied requests are not captured", func(t *testing.T) {
		h := &hookRecorder{}
		f := newFixture(t, func(o *Options, f *fixture) { o.Capture = h; f.authz.allow = map[string]bool{} })
		f.get(up.URL + "/")
		assert.Zero(t, h.pairs)
	})
}

type hookRecorder struct {
	budget     []int64
	injected   int
	pairs      int
	lastStatus int
	budgetErr  error
	injectErr  error
	captureErr error
}

func (h *hookRecorder) Allow(_ context.Context, _ identity.RequestIdentity, n int64) error {
	h.budget = append(h.budget, n)
	return h.budgetErr
}

func (h *hookRecorder) Inject(req *http.Request, _ identity.RequestIdentity) error {
	h.injected++
	req.Header.Set("X-Injected", "injected")
	return h.injectErr
}

func (h *hookRecorder) OnPair(_ *http.Request, resp *http.Response) error {
	h.pairs++
	h.lastStatus = resp.StatusCode
	return h.captureErr
}

func TestNotReadyFailsClosed(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)
	f.gate.ready.Store(false)
	resp, body := f.get(up.URL + "/")
	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	assert.Equal(t, "gateway_not_ready", decodeProblem(t, body).Code)
	assert.Zero(t, f.dials.Load())

	f.gate.ready.Store(true)
	resp, _ = f.get(up.URL + "/")
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestHandlerWithoutGateDenies(t *testing.T) {
	f := newFixture(t)
	p, err := New(Options{
		Addr: "127.0.0.1:0", ReadTimeout: time.Second, WriteTimeout: time.Second, IdleTimeout: time.Second,
		MaxHeaderBytes: 4096, Auth: f.plane.opts.Auth,
	})
	require.NoError(t, err)
	rec := httptest.NewRecorder()
	p.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestUpstreamConnectionsAreNeverReusedAcrossRequests(t *testing.T) {
	up := newUpstream(t)
	f := newFixture(t)
	// Same TCP connection to the proxy, two requests (keep-alive on the client side).
	c, err := net.Dial("tcp", f.plane.Addr().String())
	require.NoError(t, err)
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(c)
	for range 2 {
		_, err = fmt.Fprintf(c, "GET %s/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\n\r\n", up.URL, f.auth())
		require.NoError(t, err)
		resp, err := http.ReadResponse(br, nil)
		require.NoError(t, err)
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	require.Equal(t, 2, up.hitCount())
	assert.EqualValues(t, 2, f.dials.Load(), "one fresh upstream connection per request")
	assert.NotEqual(t, up.remotes[0], up.remotes[1])
}

func TestRequestMethodLabelBoundsCardinality(t *testing.T) {
	assert.Equal(t, "GET", methodLabel("GET"))
	assert.Equal(t, "OTHER", methodLabel("X-ATTACKER-"+uuid.NewString()))
}

func TestShutdownClosesLiveTunnels(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = echo.Close() }()
	go func() {
		c, aerr := echo.Accept()
		if aerr == nil {
			defer func() { _ = c.Close() }()
			_, _ = io.Copy(io.Discard, c)
		}
	}()
	_, ps, _ := net.SplitHostPort(echo.Addr().String())
	var port int
	_, _ = fmt.Sscan(ps, &port)
	f := newFixture(t, func(o *Options, _ *fixture) {
		o.AllowRawTunnel = true
		o.MITMEnabled = false
		o.ConnectPorts = []int{port}
	})

	c, err := net.Dial("tcp", f.plane.Addr().String())
	require.NoError(t, err)
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: x\r\nProxy-Authorization: %s\r\n\r\n", echo.Addr(), f.auth())
	require.NoError(t, err)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_ = f.plane.Shutdown(ctx)
	_, err = io.ReadAll(br)
	assert.NoError(t, err, "the tunnel is torn down by shutdown (EOF), not left open")
}

func TestNewValidatesOptions(t *testing.T) {
	_, err := New(Options{})
	require.Error(t, err)
	f := newFixture(t)
	_, err = New(Options{Addr: ":0", Auth: f.plane.opts.Auth})
	require.Error(t, err, "timeouts and header cap are required")
	_, err = New(Options{
		Addr: ":0", ReadTimeout: 1, WriteTimeout: 1, IdleTimeout: 1, MaxHeaderBytes: 1,
		Auth: f.plane.opts.Auth, Registerer: f.reg,
	})
	require.Error(t, err, "metrics registered twice on one registry")
}

func TestStartTwiceAndBindFailure(t *testing.T) {
	f := newFixture(t)
	require.Error(t, f.plane.Start(context.Background(), f.gate, server.Hooks{}))

	p, err := New(Options{
		Addr: "127.0.0.1:0", ReadTimeout: time.Second, WriteTimeout: time.Second, IdleTimeout: time.Second,
		MaxHeaderBytes: 4096, Auth: f.plane.opts.Auth,
		Listen: func(string, string) (net.Listener, error) { return nil, errors.New("address in use") },
	})
	require.NoError(t, err)
	require.ErrorContains(t, p.Start(context.Background(), f.gate, server.Hooks{}), "address in use")
	require.NoError(t, p.Shutdown(context.Background()), "shutdown before start is a no-op")
}

func TestLogAuditor(t *testing.T) {
	var sb strings.Builder
	a := LogAuditor{Logger: newTestLogger(&sb)}
	require.NoError(t, a.RequestDenied(context.Background(), DeniedEvent{Type: AuditEventRequestDenied, Code: "c", MatchedRule: "r"}))
	assert.Contains(t, sb.String(), "egress.request_denied")
	assert.Contains(t, sb.String(), `"matched_rule":"r"`)
}
