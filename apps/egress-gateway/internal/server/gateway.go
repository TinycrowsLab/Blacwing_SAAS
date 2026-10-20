package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/config"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

// ErrDrainTimeout is returned by Run when in-flight work did not finish within the
// configured drain timeout; remaining connections were closed (fail closed).
var ErrDrainTimeout = errors.New("graceful drain exceeded GATEWAY_DRAIN_TIMEOUT; remaining connections closed")

// Audit event types emitted by the gateway lifecycle.
const (
	AuditGatewayStarted = "gateway.started"
	AuditGatewayStopped = "gateway.stopped"
)

// AuditEvent is a lifecycle audit event. It carries the config hash, never values.
type AuditEvent struct {
	Type       string
	ConfigHash string
	Version    string
	Commit     string
	Reason     string
}

// AuditSink receives lifecycle audit events. The default LogAuditSink writes them
// as structured logs; the packages/audit ledger sink plugs in here when the
// gateway's audit transport is wired.
type AuditSink interface {
	Emit(ctx context.Context, ev AuditEvent) error
}

// LogAuditSink writes audit events to a logger with component=audit.
type LogAuditSink struct{ Logger *slog.Logger }

// Emit implements AuditSink.
func (s LogAuditSink) Emit(ctx context.Context, ev AuditEvent) error {
	attrs := []slog.Attr{
		slog.String("event", ev.Type),
		slog.String("config_hash", ev.ConfigHash),
		slog.String("build_version", ev.Version),
		slog.String("commit", ev.Commit),
	}
	if ev.Reason != "" {
		attrs = append(attrs, slog.String("reason", ev.Reason))
	}
	obs.Component(s.Logger, obs.ComponentAudit).LogAttrs(ctx, slog.LevelInfo, "audit event", attrs...)
	return nil
}

// Flusher flushes buffered telemetry during shutdown.
type Flusher interface {
	ForceFlush(ctx context.Context) error
}

// Options configures a Gateway. Config, Logger and Metrics are required.
type Options struct {
	Config  *config.Config
	Logger  *slog.Logger
	Metrics *obs.Metrics
	Version string
	Commit  string

	// Tracer provides the gateway.startup span; nil uses a no-op tracer.
	Tracer trace.TracerProvider
	// Telemetry is flushed during shutdown; optional.
	Telemetry Flusher
	// Audit receives gateway.started/stopped; nil logs them (LogAuditSink).
	Audit AuditSink

	// Hooks; nil members get the fail-closed defaults (SnapshotFileProvider,
	// ValkeyProbe, DefaultCapturer, DefaultSessionInjector).
	Hooks Hooks
	// DataPlanes are started only after the gateway first becomes ready.
	DataPlanes []DataPlane

	// CheckInterval is the readiness re-check period while checks pass (default 1s).
	CheckInterval time.Duration
	// BackoffMin/BackoffMax bound the re-check backoff while a check fails
	// (defaults 250ms and 30s).
	BackoffMin, BackoffMax time.Duration

	// Listen binds the management listener (default net.Listen).
	Listen func(network, addr string) (net.Listener, error)
	// OnListening is called with the bound management address; optional.
	OnListening func(addr net.Addr)
}

// Gateway is the egress gateway process chassis.
type Gateway struct {
	opts      Options
	cfg       *config.Config
	log       *slog.Logger
	readiness *Readiness
	mgmt      *http.ServeMux

	mu      sync.Mutex
	started []DataPlane
}

// New validates opts and fills defaults.
func New(opts Options) (*Gateway, error) {
	if opts.Config == nil || opts.Logger == nil || opts.Metrics == nil {
		return nil, errors.New("server: Config, Logger and Metrics are required")
	}
	if opts.Tracer == nil {
		opts.Tracer = noop.NewTracerProvider()
	}
	if opts.Audit == nil {
		opts.Audit = LogAuditSink{Logger: opts.Logger}
	}
	if opts.Hooks.Policy == nil {
		opts.Hooks.Policy = SnapshotFileProvider{Path: opts.Config.PolicySnapshotPath}
	}
	if opts.Hooks.Budget == nil {
		opts.Hooks.Budget = ValkeyProbe{URL: opts.Config.ValkeyURL}
	}
	if opts.Hooks.Capture == nil {
		opts.Hooks.Capture = DefaultCapturer()
	}
	if opts.Hooks.Sessions == nil {
		opts.Hooks.Sessions = DefaultSessionInjector()
	}
	if opts.CheckInterval <= 0 {
		opts.CheckInterval = time.Second
	}
	if opts.BackoffMin <= 0 {
		opts.BackoffMin = 250 * time.Millisecond
	}
	if opts.BackoffMax < opts.BackoffMin {
		opts.BackoffMax = max(30*time.Second, opts.BackoffMin)
	}
	if opts.Listen == nil {
		opts.Listen = net.Listen
	}
	g := &Gateway{
		opts:      opts,
		cfg:       opts.Config,
		log:       opts.Logger,
		readiness: NewReadiness(),
		mgmt:      http.NewServeMux(),
	}
	g.mgmt.HandleFunc("/healthz", g.handleHealthz)
	g.mgmt.HandleFunc("/readyz", g.handleReadyz)
	g.mgmt.Handle("/metrics", getOnly(opts.Metrics.Handler()))
	return g, nil
}

// Readiness exposes the gateway's readiness state (it implements Gate).
func (g *Gateway) Readiness() *Readiness { return g.readiness }

// HandleControl mounts a management-plane handler (reserved for the control API,
// EGRESS-013). It must be called before Run. Paths must not shadow the health or
// metrics endpoints.
func (g *Gateway) HandleControl(pattern string, h http.Handler) {
	g.mgmt.Handle(pattern, h)
}

// Run binds the management plane, keeps readiness current, starts the data planes
// once ready, and on ctx cancellation drains within the configured timeout. A bind
// failure (for example a port already in use) is returned before anything starts.
func (g *Gateway) Run(ctx context.Context) error {
	boot := obs.Component(g.log, obs.ComponentBootstrap)
	sw := obs.StartStopwatch()
	_, span := g.opts.Tracer.Tracer(obs.ServiceName).Start(ctx, "gateway.startup")

	ln, err := g.opts.Listen("tcp", g.cfg.MgmtAddr)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "management listener bind failed")
		span.End()
		return fmt.Errorf("bind management listener %s: %w", g.cfg.MgmtAddr, err)
	}
	span.SetAttributes(attribute.String("mgmt.addr", ln.Addr().String()))
	if g.opts.OnListening != nil {
		g.opts.OnListening(ln.Addr())
	}

	srv := &http.Server{
		Handler:           g.mgmt,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(obs.Component(g.log, obs.ComponentMgmt).Handler(), slog.LevelWarn),
	}
	serveErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	g.opts.Metrics.SetUp(true)
	g.opts.Metrics.SetReadiness(false, ReasonStarting.Code())
	g.emitAudit(ctx, AuditGatewayStarted, "")

	loopCtx, stopLoop := context.WithCancel(context.Background())
	loopDone := make(chan struct{})
	fatal := make(chan error, 1)
	go func() {
		defer close(loopDone)
		g.readinessLoop(loopCtx, fatal)
	}()

	span.End()
	// Readiness starts as "starting" (not ready) and is evaluated asynchronously, so
	// a slow dependency never delays liveness or shutdown.
	boot.Info("egress gateway started",
		slog.String("mgmt_addr", ln.Addr().String()),
		slog.Bool("ready", false),
		slog.String("reason", string(ReasonStarting)),
		slog.Int64("startup_ms", sw.Elapsed().Milliseconds()),
	)

	var runErr error
	stopReason := "signal"
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		runErr = fmt.Errorf("management server: %w", err)
		stopReason = "management server failed"
	case err := <-fatal:
		runErr = err
		stopReason = "data plane failed"
	}

	drainErr := g.shutdown(srv, stopLoop, loopDone, boot)
	g.emitAudit(context.WithoutCancel(ctx), AuditGatewayStopped, stopReason)
	return errors.Join(runErr, drainErr)
}

// shutdown drains the management plane and data planes within DrainTimeout.
func (g *Gateway) shutdown(srv *http.Server, stopLoop context.CancelFunc, loopDone <-chan struct{}, boot *slog.Logger) error {
	sw := obs.StartStopwatch()
	snap := g.readiness.shutdown()
	g.opts.Metrics.SetReadiness(false, snap.Reason.Code())
	stopLoop()
	<-loopDone
	boot.Info("egress gateway draining", slog.String("drain_timeout", g.cfg.DrainTimeout.String()))

	drainCtx, cancel := context.WithTimeout(context.Background(), g.cfg.DrainTimeout)
	defer cancel()

	var wg sync.WaitGroup
	errs := make(chan error, len(g.opts.DataPlanes)+1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := srv.Shutdown(drainCtx); err != nil {
			_ = srv.Close()
			errs <- err
		}
	}()
	g.mu.Lock()
	started := append([]DataPlane(nil), g.started...)
	g.mu.Unlock()
	for _, dp := range started {
		wg.Add(1)
		go func(dp DataPlane) {
			defer wg.Done()
			if err := dp.Shutdown(drainCtx); err != nil {
				errs <- fmt.Errorf("data plane %s: %w", dp.Name(), err)
			}
		}(dp)
	}
	wg.Wait()
	close(errs)

	var drainErr error
	timedOut := drainCtx.Err() != nil
	for err := range errs {
		if errors.Is(err, context.DeadlineExceeded) {
			timedOut = true
			continue
		}
		drainErr = errors.Join(drainErr, err)
	}
	if timedOut {
		drainErr = errors.Join(ErrDrainTimeout, drainErr)
	}

	if g.opts.Telemetry != nil {
		flushCtx, cancelFlush := context.WithTimeout(context.Background(), 2*time.Second)
		if err := g.opts.Telemetry.ForceFlush(flushCtx); err != nil {
			boot.Warn("telemetry flush failed", slog.String("error", err.Error()))
		}
		cancelFlush()
	}
	g.opts.Metrics.SetUp(false)

	attrs := []any{slog.Int64("drain_ms", sw.Elapsed().Milliseconds()), slog.Bool("timed_out", timedOut)}
	if drainErr != nil {
		boot.Error("egress gateway stopped with errors", append(attrs, slog.String("error", drainErr.Error()))...)
	} else {
		boot.Info("egress gateway stopped", attrs...)
	}
	return drainErr
}

// readinessLoop re-evaluates readiness: every CheckInterval while ready, with
// capped exponential backoff while not ready. Data planes start on the first
// transition to ready.
func (g *Gateway) readinessLoop(ctx context.Context, fatal chan<- error) {
	b := Backoff{Min: g.opts.BackoffMin, Max: g.opts.BackoffMax}
	for {
		last := g.check(ctx)
		if ctx.Err() != nil {
			return
		}
		if last.Ready {
			b.Reset()
			if err := g.startDataPlanes(ctx); err != nil {
				select {
				case fatal <- err:
				default:
				}
				return
			}
		}
		delay := g.opts.CheckInterval
		if !last.Ready {
			delay = b.Next()
		}
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// check evaluates readiness once and publishes it to state, metrics and logs.
func (g *Gateway) check(ctx context.Context) Snapshot {
	s := evaluate(ctx, g.opts.Hooks.Policy, g.opts.Hooks.Budget)
	if ctx.Err() != nil {
		return g.readiness.Snapshot()
	}
	stored, changed := g.readiness.set(s)
	if changed {
		g.opts.Metrics.SetReadiness(stored.Ready, stored.Reason.Code())
		lvl := slog.LevelWarn
		if stored.Ready {
			lvl = slog.LevelInfo
		}
		obs.Component(g.log, obs.ComponentReadiness).Log(ctx, lvl, "readiness changed",
			slog.Bool("ready", stored.Ready), slog.String("reason", string(stored.Reason)))
	}
	return stored
}

// startDataPlanes starts each data plane once, only when the gateway is ready.
func (g *Gateway) startDataPlanes(ctx context.Context) error {
	if !g.readiness.Ready() {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.started) == len(g.opts.DataPlanes) {
		return nil
	}
	for _, dp := range g.opts.DataPlanes[len(g.started):] {
		if err := dp.Start(ctx, g.readiness, g.opts.Hooks); err != nil {
			return fmt.Errorf("start data plane %s: %w", dp.Name(), err)
		}
		g.started = append(g.started, dp)
		obs.Component(g.log, obs.ComponentBootstrap).Info("data plane started", slog.String("data_plane", dp.Name()))
	}
	return nil
}

func (g *Gateway) emitAudit(ctx context.Context, typ, reason string) {
	ev := AuditEvent{Type: typ, ConfigHash: g.cfg.Hash(), Version: g.opts.Version, Commit: g.opts.Commit, Reason: reason}
	if err := g.opts.Audit.Emit(ctx, ev); err != nil {
		obs.Component(g.log, obs.ComponentAudit).Error("audit emit failed",
			slog.String("event", typ), slog.String("error", err.Error()))
	}
}

func (g *Gateway) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (g *Gateway) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	s := g.readiness.Snapshot()
	status := http.StatusOK
	if !s.Ready {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, s)
}

func getOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if allowRead(w, r) {
			h.ServeHTTP(w, r)
		}
	})
}

func allowRead(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
