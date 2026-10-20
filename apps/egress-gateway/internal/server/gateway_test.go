package server_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/server"
)

// fakePolicy lets a test inject a verified snapshot (the "fake verified-snapshot
// flag" of the test plan).
type fakePolicy struct{ verified atomic.Bool }

func (p *fakePolicy) PolicyStatus(context.Context) server.PolicyStatus {
	if p.verified.Load() {
		return server.PolicyStatus{State: server.PolicyVerified}
	}
	return server.PolicyStatus{State: server.PolicyNotLoaded, Detail: "policy snapshot not present"}
}

type okBudget struct{}

func (okBudget) Ping(context.Context) error { return nil }

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	gw      *server.Gateway
	metrics *obs.Metrics
	logs    *syncBuffer
	base    string
	cancel  context.CancelFunc
	done    chan struct{}
	runErr  error
}

func testConfig(t *testing.T) *config.Config {
	t.Helper()
	return &config.Config{
		Env:                config.EnvTest,
		MgmtAddr:           "127.0.0.1:0",
		PolicySnapshotPath: filepath.Join(t.TempDir(), "policy.snapshot"),
		ValkeyURL:          config.NewSecret("redis://" + freeAddr(t) + "/0"),
		DrainTimeout:       2 * time.Second,
	}
}

func start(t *testing.T, opts server.Options, setup ...func(*server.Gateway)) *harness {
	t.Helper()
	if opts.Config == nil {
		opts.Config = testConfig(t)
	}
	logs := &syncBuffer{}
	opts.Logger = obs.NewLogger(logs, opts.Config.LogLevel, "test")
	opts.Metrics = obs.NewMetrics("test", "abc123")
	if opts.CheckInterval == 0 {
		opts.CheckInterval = 20 * time.Millisecond
	}
	if opts.BackoffMin == 0 {
		opts.BackoffMin, opts.BackoffMax = 10*time.Millisecond, 40*time.Millisecond
	}
	addrCh := make(chan net.Addr, 1)
	opts.OnListening = func(a net.Addr) { addrCh <- a }

	gw, err := server.New(opts)
	require.NoError(t, err)
	for _, f := range setup {
		f(gw)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{gw: gw, metrics: opts.Metrics, cancel: cancel, done: make(chan struct{})}
	go func() {
		h.runErr = gw.Run(ctx)
		close(h.done)
	}()

	var addr net.Addr
	select {
	case addr = <-addrCh:
	case <-h.done:
		cancel()
		t.Fatalf("gateway exited early: %v", h.runErr)
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("gateway did not bind")
	}
	h.logs, h.base = logs, "http://"+addr.String()
	t.Cleanup(func() {
		cancel()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
		}
	})
	return h
}

func (h *harness) stop(t *testing.T) error {
	t.Helper()
	h.cancel()
	select {
	case <-h.done:
		return h.runErr
	case <-time.After(10 * time.Second):
		t.Fatal("gateway did not stop")
		return nil
	}
}

func get(url string) (int, string) {
	resp, err := http.Get(url) // #nosec G107 -- loopback test URL
	if err != nil {
		return 0, ""
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, ""
	}
	return resp.StatusCode, string(b)
}

func readyz(t *testing.T, base string) (int, server.Snapshot) {
	t.Helper()
	code, body := get(base + "/readyz")
	var s server.Snapshot
	if code != 0 {
		require.NoError(t, json.Unmarshal([]byte(body), &s), body)
	}
	return code, s
}

func eventuallyReason(t *testing.T, base string, want server.Reason) {
	t.Helper()
	require.Eventually(t, func() bool {
		code, body := get(base + "/readyz")
		return code != 0 && strings.Contains(body, `"reason":"`+string(want)+`"`)
	}, 5*time.Second, 10*time.Millisecond, "readyz never reported %s", want)
}

func TestHealthzAlwaysOKAndReadyzBlocksUntilVerifiedSnapshot(t *testing.T) {
	policy := &fakePolicy{}
	h := start(t, server.Options{Hooks: server.Hooks{Policy: policy, Budget: okBudget{}}})

	code, body := get(h.base + "/healthz")
	assert.Equal(t, http.StatusOK, code)
	assert.JSONEq(t, `{"status":"ok"}`, body)

	eventuallyReason(t, h.base, server.ReasonPolicyNotLoaded)
	code, snap := readyz(t, h.base)
	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.False(t, snap.Ready)
	assert.True(t, snap.Checks["config"].OK)
	assert.False(t, snap.Checks["policy"].OK)
	assert.True(t, snap.Checks["valkey"].OK)
	_, metrics := get(h.base + "/metrics")
	assert.Contains(t, metrics, "egress_ready 0")
	assert.Contains(t, metrics, "egress_not_ready_reason 2")
	assert.False(t, h.gw.Readiness().Ready())

	policy.verified.Store(true)
	require.Eventually(t, func() bool {
		code, _ := get(h.base + "/readyz")
		return code == http.StatusOK
	}, 5*time.Second, 10*time.Millisecond)
	_, snap = readyz(t, h.base)
	assert.Equal(t, server.ReasonReady, snap.Reason)
	_, metrics = get(h.base + "/metrics")
	assert.Contains(t, metrics, "egress_ready 1")
	assert.Contains(t, metrics, "egress_not_ready_reason 0")
	assert.Contains(t, metrics, "egress_up 1")
	assert.Contains(t, metrics, `egress_build_info{commit="abc123",version="test"} 1`)

	// Losing the snapshot drops readiness again (fail closed).
	policy.verified.Store(false)
	eventuallyReason(t, h.base, server.ReasonPolicyNotLoaded)
	require.NoError(t, h.stop(t))
}

func TestDefaultPolicyProviderNeverReady(t *testing.T) {
	cfg := testConfig(t)
	require.NoError(t, os.WriteFile(cfg.PolicySnapshotPath, []byte("unsigned"), 0o600))
	h := start(t, server.Options{Config: cfg, Hooks: server.Hooks{Budget: okBudget{}}})
	eventuallyReason(t, h.base, server.ReasonPolicyUnverified)
	code, _ := get(h.base + "/readyz")
	assert.Equal(t, http.StatusServiceUnavailable, code, "an unverified snapshot never makes the gateway ready")
}

// Edge case: policy path present but unreadable -> not ready, reason in /readyz.
func TestUnreadablePolicyPathIsNotReady(t *testing.T) {
	cfg := testConfig(t)
	require.NoError(t, os.Mkdir(cfg.PolicySnapshotPath, 0o700)) // a directory cannot be read as a snapshot
	h := start(t, server.Options{Config: cfg, Hooks: server.Hooks{Budget: okBudget{}}})
	eventuallyReason(t, h.base, server.ReasonPolicyUnreadable)
	code, snap := readyz(t, h.base)
	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.Equal(t, "policy snapshot unreadable", snap.Checks["policy"].Detail)
}

func TestSnapshotFileProviderStates(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	assert.Equal(t, server.PolicyNotLoaded, server.SnapshotFileProvider{Path: filepath.Join(dir, "missing")}.PolicyStatus(ctx).State)
	assert.Equal(t, server.PolicyUnreadable, server.SnapshotFileProvider{Path: dir}.PolicyStatus(ctx).State)

	file := filepath.Join(dir, "snap")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	assert.Equal(t, server.PolicyUnverified, server.SnapshotFileProvider{Path: file}.PolicyStatus(ctx).State)

	if os.Geteuid() != 0 { // root ignores file modes
		require.NoError(t, os.Chmod(file, 0o000))
		assert.Equal(t, server.PolicyUnreadable, server.SnapshotFileProvider{Path: file}.PolicyStatus(ctx).State)
	}
}

// fakeValkey is a minimal RESP server answering AUTH and PING.
type fakeValkey struct {
	ln       net.Listener
	password string
	auths    atomic.Int32
}

func serveFakeValkey(t *testing.T, addr, password string) *fakeValkey {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	require.NoError(t, err)
	f := &fakeValkey{ln: ln, password: password}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.handle(c)
		}
	}()
	return f
}

func (f *fakeValkey) handle(c net.Conn) {
	defer func() { _ = c.Close() }()
	r := bufio.NewReader(c)
	authed := f.password == ""
	for {
		args, err := readRESP(r)
		if err != nil {
			return
		}
		switch strings.ToUpper(args[0]) {
		case "AUTH":
			f.auths.Add(1)
			if args[len(args)-1] == f.password {
				authed = true
				_, _ = io.WriteString(c, "+OK\r\n")
			} else {
				_, _ = io.WriteString(c, "-WRONGPASS invalid\r\n")
			}
		case "PING":
			if !authed {
				_, _ = io.WriteString(c, "-NOAUTH required\r\n")
				continue
			}
			_, _ = io.WriteString(c, "+PONG\r\n")
		}
	}
}

func readRESP(r *bufio.Reader) ([]string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	var n int
	if _, err := fmt.Sscanf(strings.TrimSpace(line), "*%d", &n); err != nil {
		return nil, err
	}
	args := make([]string, 0, n)
	for range n {
		if _, err := r.ReadString('\n'); err != nil { // $len
			return nil, err
		}
		v, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		args = append(args, strings.TrimRight(v, "\r\n"))
	}
	if len(args) == 0 {
		return nil, errors.New("empty command")
	}
	return args, nil
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	a := ln.Addr().String()
	require.NoError(t, ln.Close())
	return a
}

// Edge case: Valkey unreachable at boot -> /readyz 503 and fail closed; the gateway
// retries with backoff and becomes ready once Valkey appears.
func TestValkeyUnreachableAtBootRetriesWithBackoff(t *testing.T) {
	addr := freeAddr(t)
	cfg := testConfig(t)
	cfg.ValkeyURL = config.NewSecret("redis://:hunter2-" + "pw@" + addr + "/0")
	policy := &fakePolicy{}
	policy.verified.Store(true)
	h := start(t, server.Options{Config: cfg, Hooks: server.Hooks{Policy: policy}})

	eventuallyReason(t, h.base, server.ReasonValkeyUnreachable)
	code, snap := readyz(t, h.base)
	assert.Equal(t, http.StatusServiceUnavailable, code)
	assert.NotContains(t, snap.Checks["valkey"].Detail, "hunter2", "the Valkey password never appears in readyz")
	assert.False(t, h.gw.Readiness().Ready())

	fv := serveFakeValkey(t, addr, "hunter2-pw")
	require.Eventually(t, func() bool {
		code, _ := get(h.base + "/readyz")
		return code == http.StatusOK
	}, 5*time.Second, 10*time.Millisecond)
	assert.Positive(t, fv.auths.Load())
	assert.NotContains(t, h.logs.String(), "hunter2")
}

func TestValkeyProbe(t *testing.T) {
	ctx := context.Background()
	addr := freeAddr(t)
	serveFakeValkey(t, addr, "s3cret")

	assert.NoError(t, server.ValkeyProbe{URL: config.NewSecret("redis://:s3cret@" + addr)}.Ping(ctx))
	assert.NoError(t, server.ValkeyProbe{URL: config.NewSecret("valkey://default:s3cret@" + addr)}.Ping(ctx))
	err := server.ValkeyProbe{URL: config.NewSecret("redis://:wrong-" + "s3cret@" + addr)}.Ping(ctx)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "wrong")
	assert.Error(t, server.ValkeyProbe{URL: config.NewSecret("redis://" + addr)}.Ping(ctx), "NOAUTH is a failure")
	assert.Error(t, server.ValkeyProbe{URL: config.NewSecret("redis://127.0.0.1:1"), Timeout: 200 * time.Millisecond}.Ping(ctx))

	open := freeAddr(t)
	serveFakeValkey(t, open, "")
	assert.NoError(t, server.ValkeyProbe{URL: config.NewSecret("redis://" + open + "/0")}.Ping(ctx))
}

func TestBackoffDoublesUpToMaxAndResets(t *testing.T) {
	b := server.Backoff{Min: 250 * time.Millisecond, Max: time.Second}
	var got []time.Duration
	for range 5 {
		got = append(got, b.Next())
	}
	assert.Equal(t, []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, time.Second, time.Second}, got)
	b.Reset()
	assert.Equal(t, 250*time.Millisecond, b.Next())
}

// fakeDataPlane records lifecycle calls; it simulates one in-flight connection
// during Shutdown when hold is set.
type fakeDataPlane struct {
	started   atomic.Int32
	readyAtGo atomic.Bool
	stopped   atomic.Bool
	gate      atomic.Value
	hold      time.Duration
}

func (d *fakeDataPlane) Name() string { return "fake" }

func (d *fakeDataPlane) Start(_ context.Context, gate server.Gate, _ server.Hooks) error {
	d.started.Add(1)
	d.readyAtGo.Store(gate.Ready())
	d.gate.Store(gate)
	return nil
}

func (d *fakeDataPlane) Shutdown(ctx context.Context) error {
	if d.hold > 0 {
		select {
		case <-time.After(d.hold):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	d.stopped.Store(true)
	return nil
}

// Pitfall from the issue: data-plane listeners are never bound before ready.
func TestDataPlanesStartOnlyOnceReadyAndDenyAfterwardsWhenNotReady(t *testing.T) {
	policy := &fakePolicy{}
	dp := &fakeDataPlane{}
	h := start(t, server.Options{Hooks: server.Hooks{Policy: policy, Budget: okBudget{}}, DataPlanes: []server.DataPlane{dp}})

	eventuallyReason(t, h.base, server.ReasonPolicyNotLoaded)
	time.Sleep(100 * time.Millisecond) // several check intervals
	assert.Zero(t, dp.started.Load(), "data plane must not start while not ready")

	policy.verified.Store(true)
	require.Eventually(t, func() bool { return dp.started.Load() == 1 }, 5*time.Second, 10*time.Millisecond)
	assert.True(t, dp.readyAtGo.Load())

	policy.verified.Store(false)
	gate, ok := dp.gate.Load().(server.Gate)
	require.True(t, ok)
	require.Eventually(t, func() bool { return !gate.Ready() }, 5*time.Second, 10*time.Millisecond,
		"the gate a data plane holds reports not ready, so it denies")
	policy.verified.Store(true)
	require.Eventually(t, gate.Ready, 5*time.Second, 10*time.Millisecond)
	assert.Equal(t, int32(1), dp.started.Load(), "data planes start at most once")

	require.NoError(t, h.stop(t))
	assert.True(t, dp.stopped.Load(), "data planes are drained on shutdown")
	assert.False(t, gate.Ready(), "readiness is latched off during shutdown")
}

// Acceptance: SIGTERM (context cancellation) drains in-flight requests within the
// configured timeout, stops accepting new connections and flushes telemetry.
func TestGracefulDrainCompletesInFlightRequests(t *testing.T) {
	inFlight := make(chan struct{})
	release := make(chan struct{})
	flushed := &flushRecorder{}
	h := start(t, server.Options{Telemetry: flushed}, func(gw *server.Gateway) {
		gw.HandleControl("/control/slow", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			close(inFlight)
			<-release
			w.WriteHeader(http.StatusNoContent)
		}))
	})

	result := make(chan int, 1)
	go func() {
		code, _ := get(h.base + "/control/slow")
		result <- code
	}()
	<-inFlight

	stopped := make(chan error, 1)
	sw := obs.StartStopwatch()
	go func() { stopped <- h.stop(t) }()

	// New connections are refused once draining has begun.
	require.Eventually(t, func() bool {
		code, _ := get(h.base + "/healthz")
		return code == 0
	}, 2*time.Second, 10*time.Millisecond, "logs: %s", h.logs)

	close(release)
	assert.Equal(t, http.StatusNoContent, <-result, "in-flight request completed")
	require.NoError(t, <-stopped)
	assert.Less(t, sw.Elapsed(), 2*time.Second)
	assert.True(t, flushed.called.Load(), "telemetry flushed on shutdown")
	assert.Contains(t, h.logs.String(), `"msg":"egress gateway stopped"`)
	assert.Contains(t, h.logs.String(), `"event":"gateway.stopped"`)
	_, _ = get(h.base + "/metrics")
}

func TestDrainTimeoutClosesRemainingConnections(t *testing.T) {
	cfg := testConfig(t)
	cfg.DrainTimeout = 200 * time.Millisecond
	inFlight := make(chan struct{})
	dp := &fakeDataPlane{hold: 5 * time.Second}
	policy := &fakePolicy{}
	policy.verified.Store(true)
	h := start(t, server.Options{Config: cfg, Hooks: server.Hooks{Policy: policy, Budget: okBudget{}}, DataPlanes: []server.DataPlane{dp}},
		func(gw *server.Gateway) {
			gw.HandleControl("/control/hang", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				close(inFlight)
				<-r.Context().Done()
			}))
		})
	require.Eventually(t, func() bool { return dp.started.Load() == 1 }, 5*time.Second, 10*time.Millisecond)
	go func() { _, _ = get(h.base + "/control/hang") }()
	<-inFlight

	sw := obs.StartStopwatch()
	err := h.stop(t)
	elapsed := sw.Elapsed()
	require.ErrorIs(t, err, server.ErrDrainTimeout)
	assert.GreaterOrEqual(t, elapsed, 150*time.Millisecond)
	assert.Less(t, elapsed, 2*time.Second, "drain is bounded by GATEWAY_DRAIN_TIMEOUT")
	assert.False(t, dp.stopped.Load())
}

// Edge case: port already in use -> fatal startup error.
func TestRunFailsWhenManagementPortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = ln.Close() }()
	cfg := testConfig(t)
	cfg.MgmtAddr = ln.Addr().String()
	gw, err := server.New(server.Options{Config: cfg, Logger: obs.NewLogger(io.Discard, nil, "t"), Metrics: obs.NewMetrics("t", "c")})
	require.NoError(t, err)
	err = gw.Run(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "bind management listener")
}

func TestStartupSpanAndAuditEvents(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	audit := &auditRecorder{}
	cfg := testConfig(t)
	h := start(t, server.Options{Config: cfg, Tracer: tp, Audit: audit, Hooks: server.Hooks{Budget: okBudget{}}})
	require.NoError(t, h.stop(t))

	spans := rec.Ended()
	require.Len(t, spans, 1)
	assert.Equal(t, "gateway.startup", spans[0].Name())

	evs := audit.events()
	require.Len(t, evs, 2)
	assert.Equal(t, server.AuditGatewayStarted, evs[0].Type)
	assert.Equal(t, server.AuditGatewayStopped, evs[1].Type)
	assert.Equal(t, cfg.Hash(), evs[0].ConfigHash)
	assert.Equal(t, "signal", evs[1].Reason)
}

func TestManagementEndpointsRejectWrites(t *testing.T) {
	h := start(t, server.Options{Hooks: server.Hooks{Budget: okBudget{}}})
	for _, p := range []string{"/healthz", "/readyz", "/metrics"} {
		resp, err := http.Post(h.base+p, "text/plain", strings.NewReader("x")) // #nosec G107 -- loopback
		require.NoError(t, err)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode, p)
	}
}

func TestNewRequiresCoreOptions(t *testing.T) {
	_, err := server.New(server.Options{})
	assert.Error(t, err)
}

func TestDefaultCaptureAndSessionHooksFailClosed(t *testing.T) {
	assert.ErrorIs(t, server.DefaultCapturer().Healthy(context.Background()), server.ErrNotImplemented)
	assert.ErrorIs(t, server.DefaultSessionInjector().Healthy(context.Background()), server.ErrNotImplemented)
}

type flushRecorder struct{ called atomic.Bool }

func (f *flushRecorder) ForceFlush(context.Context) error { f.called.Store(true); return nil }

type auditRecorder struct {
	mu  sync.Mutex
	evs []server.AuditEvent
}

func (a *auditRecorder) Emit(_ context.Context, ev server.AuditEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.evs = append(a.evs, ev)
	return nil
}

func (a *auditRecorder) events() []server.AuditEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]server.AuditEvent(nil), a.evs...)
}
