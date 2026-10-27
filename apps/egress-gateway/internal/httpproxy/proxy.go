package httpproxy

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/elazarl/goproxy"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/server"
)

// Component is the log component value of this package.
const Component = "httpproxy"

// allowedMethods is the closed set of methods the proxy forwards; anything else is denied.
var allowedMethods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true, http.MethodPut: true,
	http.MethodPatch: true, http.MethodDelete: true, http.MethodOptions: true, http.MethodTrace: true,
}

// DefaultConnectPorts are the ports a CONNECT may target unless Options.ConnectPorts says otherwise.
var DefaultConnectPorts = []int{443, 8443}

// Options configures a Plane. Addr and Auth are required; every other zero value is
// the fail-closed or documented default.
type Options struct {
	// Addr is the listen address (GATEWAY_HTTP_PROXY_ADDR).
	Addr string
	// ReadTimeout, WriteTimeout, IdleTimeout and MaxHeaderBytes configure the listener
	// (GATEWAY_READ_TIMEOUT, GATEWAY_WRITE_TIMEOUT, GATEWAY_IDLE_TIMEOUT,
	// GATEWAY_MAX_HEADER_BYTES). Zero means the Go net/http default of "no limit" and
	// is rejected: they are all required.
	ReadTimeout, WriteTimeout, IdleTimeout time.Duration
	MaxHeaderBytes                         int
	// UpstreamTimeout bounds waiting for upstream response headers (default 30s).
	UpstreamTimeout time.Duration
	// MITMEnabled (GATEWAY_MITM_ENABLED) sends authorised CONNECTs to MITM when set.
	MITMEnabled bool
	// MITM is the TLS interception hook (EGRESS-006).
	MITM ConnectInterceptor
	// AllowRawTunnel permits an unintercepted TCP tunnel when MITM is disabled or has no
	// hook. It exists for tests only: a raw tunnel bypasses capture (§8.2), so main
	// never sets it.
	AllowRawTunnel bool
	// ConnectPorts are the CONNECT target ports (default DefaultConnectPorts).
	ConnectPorts []int

	Auth       *identity.Authenticator
	Authorizer Authorizer // nil: DenyAll
	Budget     BudgetGuard
	Sessions   SessionInjector
	Capture    Capturer
	Audit      Auditor

	Logger     *slog.Logger
	Registerer prometheus.Registerer
	Tracer     trace.TracerProvider
	// Dial opens upstream connections (default net.Dialer with a 10s timeout).
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// Listen binds the listener (default net.Listen).
	Listen func(network, addr string) (net.Listener, error)
}

// Plane is the HTTP/1.1 proxy data plane. It implements server.DataPlane.
type Plane struct {
	opts    Options
	log     *slog.Logger
	tracer  trace.Tracer
	met     *metrics
	proxy   *goproxy.ProxyHttpServer
	tr      *http.Transport
	ports   map[int]bool
	gate    atomic.Pointer[server.Gate]
	tunnels tunnelSet

	mu   sync.Mutex
	srv  *http.Server
	addr net.Addr
}

// New validates opts and builds the Plane. It binds nothing until Start.
func New(opts Options) (*Plane, error) {
	if opts.Auth == nil {
		return nil, errors.New("httpproxy: Auth is required")
	}
	if opts.Addr == "" || opts.ReadTimeout <= 0 || opts.WriteTimeout <= 0 || opts.IdleTimeout <= 0 || opts.MaxHeaderBytes <= 0 {
		return nil, errors.New("httpproxy: Addr, timeouts and MaxHeaderBytes are required")
	}
	if opts.Authorizer == nil {
		opts.Authorizer = DenyAll{}
	}
	if opts.Budget == nil {
		opts.Budget = Nop{}
	}
	if opts.Sessions == nil {
		opts.Sessions = Nop{}
	}
	if opts.Capture == nil {
		opts.Capture = Nop{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Audit == nil {
		opts.Audit = LogAuditor{Logger: opts.Logger}
	}
	if opts.Tracer == nil {
		opts.Tracer = noop.NewTracerProvider()
	}
	if opts.UpstreamTimeout <= 0 {
		opts.UpstreamTimeout = 30 * time.Second
	}
	if len(opts.ConnectPorts) == 0 {
		opts.ConnectPorts = DefaultConnectPorts
	}
	if opts.Dial == nil {
		d := &net.Dialer{Timeout: 10 * time.Second}
		opts.Dial = d.DialContext
	}
	if opts.Listen == nil {
		opts.Listen = net.Listen
	}
	met, err := newMetrics(opts.Registerer)
	if err != nil {
		return nil, err
	}
	p := &Plane{
		opts:   opts,
		log:    opts.Logger.With(slog.String(obs.FieldComponent, Component)),
		tracer: opts.Tracer.Tracer(obs.ServiceName),
		met:    met,
		ports:  make(map[int]bool, len(opts.ConnectPorts)),
	}
	for _, port := range opts.ConnectPorts {
		p.ports[port] = true
	}
	p.tr = &http.Transport{
		// No env proxy, no keep-alive (an upstream connection never serves a second
		// identity), no transparent gzip (evidence must be the bytes on the wire) and
		// HTTP/1.1 only.
		Proxy:                 nil,
		DialContext:           p.dial,
		DisableKeepAlives:     true,
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		TLSNextProto:          map[string]func(string, *tls.Conn) http.RoundTripper{},
		ResponseHeaderTimeout: opts.UpstreamTimeout,
	}
	p.proxy = p.buildProxy()
	return p, nil
}

// dial dials upstream and tracks the connection so Shutdown can close live tunnels.
func (p *Plane) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	c, err := p.opts.Dial(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	return p.tunnels.track(c), nil
}

func (p *Plane) buildProxy() *goproxy.ProxyHttpServer {
	px := goproxy.NewProxyHttpServer()
	px.Logger = slog.NewLogLogger(p.log.Handler(), slog.LevelDebug)
	px.Tr = p.tr
	px.KeepAcceptEncoding = true
	px.ConnectDialWithReq = func(req *http.Request, network, addr string) (net.Conn, error) {
		return p.dial(req.Context(), network, addr)
	}
	px.NonproxyHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		http.Error(w, "this is a forward proxy; absolute-form request targets are required", http.StatusBadRequest)
	})
	px.OnRequest().DoFunc(p.onRequest)
	px.OnRequest().HandleConnectFunc(p.onConnect)
	px.OnResponse().DoFunc(p.onResponse)
	return px
}

// Name implements server.DataPlane.
func (p *Plane) Name() string { return Component }

// Addr returns the bound listener address, or nil before Start.
func (p *Plane) Addr() net.Addr {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.addr
}

// Handler returns the proxy handler. Requests are denied with 503 until Start (or
// SetGate) provides a ready gate.
func (p *Plane) Handler() http.Handler { return http.HandlerFunc(p.serve) }

// SetGate installs the readiness gate consulted on every request.
func (p *Plane) SetGate(g server.Gate) { p.gate.Store(&g) }

// Start implements server.DataPlane: it binds the listener and serves in the background.
func (p *Plane) Start(_ context.Context, gate server.Gate, _ server.Hooks) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.srv != nil {
		return errors.New("httpproxy: already started")
	}
	p.SetGate(gate)
	ln, err := p.opts.Listen("tcp", p.opts.Addr)
	if err != nil {
		return fmt.Errorf("bind http proxy listener %s: %w", p.opts.Addr, err)
	}
	p.srv = &http.Server{
		Handler:           p.Handler(),
		ReadHeaderTimeout: p.opts.ReadTimeout,
		ReadTimeout:       p.opts.ReadTimeout,
		WriteTimeout:      p.opts.WriteTimeout,
		IdleTimeout:       p.opts.IdleTimeout,
		MaxHeaderBytes:    p.opts.MaxHeaderBytes,
		// A non-nil empty map disables the automatic HTTP/2 upgrade (v1 is HTTP/1.1 only).
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
		ErrorLog:     slog.NewLogLogger(p.log.Handler(), slog.LevelWarn),
	}
	p.addr = ln.Addr()
	go func(srv *http.Server) {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			p.log.Error("http proxy listener failed", slog.String("error", err.Error()))
		}
	}(p.srv)
	p.log.Info("http proxy listening", slog.String("addr", p.addr.String()))
	return nil
}

// Shutdown implements server.DataPlane: it stops accepting, drains in-flight
// requests until ctx ends, then closes whatever is left, tunnels included.
func (p *Plane) Shutdown(ctx context.Context) error {
	p.mu.Lock()
	srv := p.srv
	p.mu.Unlock()
	if srv == nil {
		return nil
	}
	err := srv.Shutdown(ctx)
	if err != nil {
		_ = srv.Close()
	}
	p.tunnels.closeAll()
	return err
}

// serve gates every request on readiness, then hands it to goproxy.
func (p *Plane) serve(w http.ResponseWriter, r *http.Request) {
	if g := p.gate.Load(); g == nil || !(*g).Ready() {
		p.met.requests.WithLabelValues(decisionUnavailable, methodLabel(r.Method)).Inc()
		w.Header().Set("Connection", "close")
		writeProblem(w, http.StatusServiceUnavailable, problem{Code: "gateway_not_ready", Reason: "the gateway is not ready; failing closed"})
		return
	}
	p.proxy.ServeHTTP(w, r)
}

// problem is the JSON body of every proxy-generated error.
type problem struct {
	Code        string `json:"code"`
	Reason      string `json:"reason"`
	MatchedRule string `json:"matchedRule,omitempty"`
}

func writeProblem(w http.ResponseWriter, status int, pr problem) {
	h := w.Header()
	h.Set("Content-Type", "application/problem+json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(pr)
}

// problemResponse builds a closing response carrying a problem body.
func problemResponse(req *http.Request, status int, pr problem) *http.Response {
	body, _ := json.Marshal(pr)
	resp := goproxy.NewResponse(req, "application/problem+json", status, string(body)+"\n")
	resp.Header.Set("Cache-Control", "no-store")
	resp.Header.Set("X-Content-Type-Options", "nosniff")
	resp.Header.Set("Connection", "close")
	resp.Close = true
	return resp
}

func authRequiredResponse(req *http.Request) *http.Response {
	resp := goproxy.NewResponse(req, "text/plain; charset=utf-8", http.StatusProxyAuthRequired, "proxy authentication required\n")
	resp.Header.Set("Proxy-Authenticate", identity.ProxyAuthenticateValue)
	resp.Header.Set("Connection", "close")
	resp.Close = true
	return resp
}

// reqState travels from onRequest to onResponse in ProxyCtx.UserData.
type reqState struct {
	id     identity.RequestIdentity
	method string
	host   string
	span   trace.Span
	sw     obs.Stopwatch
	// decision is set when onRequest produced the final response itself.
	decision string
	code     string
}

// target is a normalised request destination.
type target struct {
	scheme, host string
	port         int
	url          string
}

var errBadTarget = errors.New("invalid target")

// parseTarget normalises an absolute-form http URL. Userinfo, a missing host and an
// out-of-range port are rejected: they only ever serve to confuse scope matching.
func parseTarget(u *url.URL) (target, error) {
	if u == nil || u.Scheme != "http" || u.User != nil || u.Opaque != "" {
		return target{}, errBadTarget
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return target{}, errBadTarget
	}
	port, authority := 80, host
	if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	if ps := u.Port(); ps != "" {
		n, err := strconv.Atoi(ps)
		if err != nil || n < 1 || n > 65535 {
			return target{}, errBadTarget
		}
		port, authority = n, net.JoinHostPort(host, ps)
	}
	clean := url.URL{Scheme: "http", Host: authority, Path: u.Path, RawPath: u.RawPath, RawQuery: u.RawQuery}
	return target{scheme: "http", host: host, port: port, url: clean.String()}, nil
}

func (p *Plane) onRequest(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
	_, span := p.tracer.Start(req.Context(), "httpproxy.handle")
	st := &reqState{method: req.Method, span: span, sw: obs.StartStopwatch()}
	ctx.UserData = st

	id, _, err := p.opts.Auth.AuthenticateHTTP(req)
	if err != nil {
		st.decision, st.code = decisionUnauthenticated, "proxy_auth_required"
		return req, authRequiredResponse(req)
	}
	st.id = id

	tgt, deny := p.admit(req)
	if deny != nil {
		return req, p.deny(req, st, deny)
	}
	st.host = tgt.host
	span.SetAttributes(attribute.String("run_id", id.RunID.String()), attribute.String("target_host", tgt.host))

	if d := p.authorize(req, id, tgt, "http:"+req.Method, req.Method); !d.Allow {
		return req, p.deny(req, st, &denial{status: http.StatusForbidden, pr: problem{Code: d.Code, Reason: d.Reason, MatchedRule: d.MatchedRule}})
	}
	if err := p.opts.Budget.Allow(req.Context(), id, max(req.ContentLength, 0)); err != nil {
		return req, p.deny(req, st, &denial{status: http.StatusTooManyRequests, pr: problem{Code: "budget_exceeded", Reason: "the request budget for this identity is exhausted"}})
	}

	// For absolute-form targets the URL, not a client-chosen Host header, names the origin.
	req.Host = req.URL.Host
	stripHopByHop(req.Header)
	if err := p.opts.Sessions.Inject(req, id); err != nil {
		return req, p.deny(req, st, &denial{status: http.StatusServiceUnavailable, pr: problem{Code: "session_injection_failed", Reason: "session credentials could not be injected"}})
	}
	ctx.RoundTripper = goproxy.RoundTripperFunc(p.roundTrip)
	return req, nil
}

// denial is a pre-forward rejection.
type denial struct {
	status int
	pr     problem
}

// admit applies the checks that need no policy: upgrades, method, target syntax.
func (p *Plane) admit(req *http.Request) (target, *denial) {
	if hasUpgrade(req.Header) {
		return target{}, &denial{http.StatusForbidden, problem{Code: "upgrade_not_supported", Reason: "protocol upgrades (h2c, websocket) are not supported; HTTP/1.1 only"}}
	}
	if !allowedMethods[req.Method] {
		return target{}, &denial{http.StatusForbidden, problem{Code: "method_not_allowed", Reason: "the request method is not allowed"}}
	}
	tgt, err := parseTarget(req.URL)
	if err != nil {
		return target{}, &denial{http.StatusBadRequest, problem{Code: "invalid_target", Reason: "the request target must be an absolute http URL without credentials"}}
	}
	return tgt, nil
}

func (p *Plane) authorize(req *http.Request, id identity.RequestIdentity, tgt target, action, method string) Decision {
	ctx, span := p.tracer.Start(req.Context(), "policy.authorize")
	defer span.End()
	d := p.opts.Authorizer.Authorize(ctx, Request{
		Identity: id, Action: action, Method: method,
		URL: tgt.url, Scheme: tgt.scheme, Host: tgt.host, Port: tgt.port,
	})
	if !d.Allow {
		if d.Code == "" {
			d.Code = "denied"
		}
		span.SetStatus(codes.Error, "denied")
	}
	return d
}

// deny records and returns the final denial response.
func (p *Plane) deny(req *http.Request, st *reqState, d *denial) *http.Response {
	st.decision, st.code = decisionDeny, d.pr.Code
	p.auditDenied(req.Context(), st, d.pr)
	return problemResponse(req, d.status, d.pr)
}

func (p *Plane) auditDenied(ctx context.Context, st *reqState, pr problem) {
	ev := DeniedEvent{
		Type: AuditEventRequestDenied, Code: pr.Code, MatchedRule: pr.MatchedRule,
		RunID: st.id.RunID.String(), SessionID: st.id.SessionID.String(), TestCaseID: st.id.TestCaseID.String(),
		Method: methodLabel(st.method), TargetHost: st.host,
	}
	if st.id.RoleID != nil {
		ev.RoleID = st.id.RoleID.String()
	}
	if err := p.opts.Audit.RequestDenied(ctx, ev); err != nil {
		p.log.Error("audit emit failed", slog.String("event", ev.Type), slog.String("error", err.Error()))
	}
}

// roundTrip forwards to the origin. Failures become 502/504 problem responses
// without leaking the dial error, and are never retried.
func (p *Plane) roundTrip(req *http.Request, _ *goproxy.ProxyCtx) (*http.Response, error) {
	resp, err := p.tr.RoundTrip(req)
	if err == nil {
		return resp, nil
	}
	code, status := classifyUpstream(err)
	p.met.upstream.WithLabelValues(code).Inc()
	return problemResponse(req, status, problem{Code: "upstream_" + code, Reason: "the upstream request failed"}), nil
}

func classifyUpstream(err error) (code string, status int) {
	var ne net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return upstreamCanceled, http.StatusBadGateway
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return upstreamTimeout, http.StatusGatewayTimeout
	case errors.Is(err, syscall.ECONNREFUSED):
		return upstreamRefused, http.StatusBadGateway
	default:
		return upstreamError, http.StatusBadGateway
	}
}

func (p *Plane) onResponse(resp *http.Response, ctx *goproxy.ProxyCtx) *http.Response {
	st, ok := ctx.UserData.(*reqState)
	if !ok {
		// A request inside an intercepted tunnel (EGRESS-006) is authorised and
		// captured by the interception path, not here.
		return resp
	}
	defer st.span.End()
	if resp == nil {
		// goproxy had no response and no error mapping: fail closed.
		resp = problemResponse(ctx.Req, http.StatusBadGateway, problem{Code: "upstream_error", Reason: "the upstream request failed"})
	}
	if st.decision == "" {
		stripHopByHop(resp.Header)
		if err := p.opts.Capture.OnPair(ctx.Req, resp); err != nil {
			_ = resp.Body.Close()
			resp = problemResponse(ctx.Req, http.StatusBadGateway, problem{Code: "capture_failed", Reason: "evidence capture failed; the response was withheld"})
			st.decision, st.code = decisionDeny, "capture_failed"
		} else {
			st.decision = decisionAllow
		}
	}
	p.met.requests.WithLabelValues(st.decision, methodLabel(st.method)).Inc()
	p.met.duration.Observe(st.sw.Elapsed().Seconds())
	attrs := []any{
		slog.String(obs.FieldRunID, st.id.RunID.String()),
		slog.String("test_case_id", st.id.TestCaseID.String()),
		slog.String("target_host", st.host),
		slog.String("method", methodLabel(st.method)),
		slog.String("decision", st.decision),
		slog.Int("status", resp.StatusCode),
	}
	if st.id.RoleID != nil {
		attrs = append(attrs, slog.String("role_id", st.id.RoleID.String()))
	}
	if st.code != "" {
		attrs = append(attrs, slog.String("code", st.code))
	}
	lvl := slog.LevelDebug
	if st.decision != decisionAllow {
		lvl = slog.LevelInfo
	}
	p.log.Log(ctx.Req.Context(), lvl, "request handled", attrs...)
	return resp
}

// onConnect decides a CONNECT: authenticate, check the port, authorise, then pick the
// tunnel mode. Every rejection happens before any upstream dial.
func (p *Plane) onConnect(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
	req := ctx.Req
	_, span := p.tracer.Start(req.Context(), "httpproxy.handle")
	defer span.End()
	st := &reqState{method: http.MethodConnect, span: span, sw: obs.StartStopwatch()}
	reject := func(resp *http.Response) (*goproxy.ConnectAction, string) {
		p.met.requests.WithLabelValues(st.decision, "CONNECT").Inc()
		p.met.duration.Observe(st.sw.Elapsed().Seconds())
		ctx.Resp = resp
		return &goproxy.ConnectAction{Action: goproxy.ConnectReject}, host
	}

	id, _, err := p.opts.Auth.AuthenticateHTTP(req)
	if err != nil {
		st.decision = decisionUnauthenticated
		return reject(authRequiredResponse(req))
	}
	st.id = id

	tgt, perr := parseConnectTarget(host)
	if perr == nil && !p.ports[tgt.port] {
		perr = errPortNotAllowed
	}
	if perr == nil && hasUpgrade(req.Header) {
		perr = errUpgrade
	}
	if perr != nil {
		st.host = tgt.host
		return reject(p.deny(req, st, connectDenial(perr)))
	}
	st.host = tgt.host

	if d := p.authorize(req, id, tgt, "http:CONNECT", http.MethodConnect); !d.Allow {
		return reject(p.deny(req, st, &denial{status: http.StatusForbidden, pr: problem{Code: d.Code, Reason: d.Reason, MatchedRule: d.MatchedRule}}))
	}
	if err := p.opts.Budget.Allow(req.Context(), id, 0); err != nil {
		return reject(p.deny(req, st, &denial{status: http.StatusTooManyRequests, pr: problem{Code: "budget_exceeded", Reason: "the request budget for this identity is exhausted"}}))
	}

	var action *goproxy.ConnectAction
	switch {
	case p.opts.MITMEnabled && p.opts.MITM != nil:
		action = p.opts.MITM.Intercept(id, host)
	case p.opts.AllowRawTunnel:
		action = &goproxy.ConnectAction{Action: goproxy.ConnectAccept}
	}
	if action == nil {
		return reject(p.deny(req, st, &denial{status: http.StatusServiceUnavailable, pr: problem{Code: "interception_unavailable", Reason: "TLS interception is not available; the tunnel is refused"}}))
	}
	p.met.requests.WithLabelValues(decisionAllow, "CONNECT").Inc()
	p.met.duration.Observe(st.sw.Elapsed().Seconds())
	p.log.Debug("connect accepted",
		slog.String(obs.FieldRunID, id.RunID.String()), slog.String("test_case_id", id.TestCaseID.String()),
		slog.String("target_host", tgt.host), slog.String("method", "CONNECT"), slog.String("decision", decisionAllow))
	return action, host
}

var (
	errPortNotAllowed = errors.New("port not allowed")
	errUpgrade        = errors.New("upgrade")
)

func connectDenial(err error) *denial {
	switch {
	case errors.Is(err, errPortNotAllowed):
		return &denial{http.StatusForbidden, problem{Code: "port_not_allowed", Reason: "CONNECT to this port is not allowed"}}
	case errors.Is(err, errUpgrade):
		return &denial{http.StatusForbidden, problem{Code: "upgrade_not_supported", Reason: "protocol upgrades are not supported; HTTP/1.1 only"}}
	default:
		return &denial{http.StatusBadRequest, problem{Code: "invalid_target", Reason: "CONNECT requires an authority of the form host:port"}}
	}
}

// parseConnectTarget normalises a CONNECT authority, which must carry a port.
func parseConnectTarget(authority string) (target, error) {
	h, ps, err := net.SplitHostPort(authority)
	if err != nil {
		return target{}, errBadTarget
	}
	host := strings.TrimSuffix(strings.ToLower(h), ".")
	port, err := strconv.Atoi(ps)
	if host == "" || err != nil || port < 1 || port > 65535 {
		return target{}, errBadTarget
	}
	return target{scheme: "https", host: host, port: port, url: "https://" + net.JoinHostPort(host, ps)}, nil
}

// LogAuditor writes denial events as structured logs with component=audit; the
// packages/audit ledger sink replaces it when the gateway's audit transport lands.
type LogAuditor struct{ Logger *slog.Logger }

// RequestDenied implements Auditor.
func (a LogAuditor) RequestDenied(ctx context.Context, ev DeniedEvent) error {
	a.Logger.LogAttrs(ctx, slog.LevelInfo, "audit event",
		slog.String(obs.FieldComponent, obs.ComponentAudit),
		slog.String("event", ev.Type),
		slog.String("code", ev.Code),
		slog.String("matched_rule", ev.MatchedRule),
		slog.String(obs.FieldRunID, ev.RunID),
		slog.String(obs.FieldSessionID, ev.SessionID),
		slog.String("test_case_id", ev.TestCaseID),
		slog.String("role_id", ev.RoleID),
		slog.String("method", ev.Method),
		slog.String("target_host", ev.TargetHost),
	)
	return nil
}

// tunnelSet tracks live upstream connections so Shutdown can close them.
type tunnelSet struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

type trackedConn struct {
	net.Conn
	set  *tunnelSet
	once sync.Once
}

func (c *trackedConn) Close() error {
	c.once.Do(func() {
		c.set.mu.Lock()
		delete(c.set.conns, c.Conn)
		c.set.mu.Unlock()
	})
	return c.Conn.Close()
}

func (s *tunnelSet) track(c net.Conn) net.Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conns == nil {
		s.conns = make(map[net.Conn]struct{})
	}
	s.conns[c] = struct{}{}
	return &trackedConn{Conn: c, set: s}
}

func (s *tunnelSet) closeAll() {
	s.mu.Lock()
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

var _ server.DataPlane = (*Plane)(nil)
