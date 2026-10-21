// Package obs holds the egress gateway's observability primitives: the structured
// JSON logger, the Prometheus registry with the gateway's core gauges, the
// OpenTelemetry tracer provider and a monotonic stopwatch.
//
// Rules shared by every caller:
//
//   - logs are JSON lines with ts, level, msg, component and, inside a run, run_id
//     and session_id (WithRun); they never carry secrets or request/response bodies
//     (CONTEXT_PACK §8.7);
//   - metric names are prefixed egress_; later EGRESS issues register their
//     counters and histograms on Metrics.Registry;
//   - durations are measured with the monotonic clock (Stopwatch), so wall-clock
//     skew or NTP steps never produce negative or inflated durations.
package obs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// ServiceName is the service identity used in logs, metrics and traces.
const ServiceName = "egress-gateway"

// Log field names and component values (EGRESS logging contract).
const (
	FieldComponent = "component"
	FieldRunID     = "run_id"
	FieldSessionID = "session_id"

	ComponentBootstrap = "bootstrap"
	ComponentReadiness = "readiness"
	ComponentMgmt      = "mgmt"
	ComponentAudit     = "audit"
)

// NewLogger returns the service's structured JSON logger writing to w. The time
// field is renamed ts and rendered in UTC with millisecond precision.
func NewLogger(w io.Writer, level slog.Leveler, version string) *slog.Logger {
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.TimeKey {
				a.Key = "ts"
				a.Value = slog.StringValue(a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
			}
			return a
		},
	})
	return slog.New(h).With(
		slog.String("service", ServiceName),
		slog.String("version", version),
	)
}

// Component returns a child logger tagged with component.
func Component(l *slog.Logger, component string) *slog.Logger {
	return l.With(slog.String(FieldComponent, component))
}

// WithRun returns a child logger carrying run_id and session_id, the correlation
// fields every data-plane log line inside a run must have.
func WithRun(l *slog.Logger, runID, sessionID string) *slog.Logger {
	return l.With(slog.String(FieldRunID, runID), slog.String(FieldSessionID, sessionID))
}

// Stopwatch measures elapsed time on the monotonic clock.
type Stopwatch struct{ start time.Time }

// StartStopwatch starts a stopwatch. time.Now carries a monotonic reading, and
// Elapsed uses time.Since, which subtracts monotonic readings only.
func StartStopwatch() Stopwatch { return Stopwatch{start: time.Now()} }

// Elapsed returns the monotonic time since the stopwatch started (never negative).
func (s Stopwatch) Elapsed() time.Duration {
	if d := time.Since(s.start); d > 0 {
		return d
	}
	return 0
}

// Readiness reason codes exported by the label-free egress_not_ready_reason gauge
// (0 means ready). The /readyz body carries the matching reason string.
const (
	ReasonCodeReady             = 0
	ReasonCodeStarting          = 1
	ReasonCodePolicyNotLoaded   = 2
	ReasonCodePolicyUnreadable  = 3
	ReasonCodePolicyUnverified  = 4
	ReasonCodeValkeyUnreachable = 5
	ReasonCodeShuttingDown      = 6
)

// Metrics is the gateway's Prometheus registry with its core gauges.
type Metrics struct {
	// Registry is where later EGRESS issues register their own collectors.
	Registry *prometheus.Registry

	up             prometheus.Gauge
	ready          prometheus.Gauge
	notReadyReason prometheus.Gauge
	scopeEval      *prometheus.CounterVec
}

// NewMetrics creates a private registry (no global state) with egress_build_info,
// egress_up, egress_ready, egress_not_ready_reason and the Go/process collectors.
func NewMetrics(version, commit string) *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Registry: reg,
		up: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "egress_up", Help: "1 while the gateway process is running and serving its management plane.",
		}),
		ready: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "egress_ready", Help: "1 when config is valid, a verified policy snapshot is loaded and Valkey is reachable; 0 means fail closed.",
		}),
		notReadyReason: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "egress_not_ready_reason",
			Help: "Readiness reason code: 0 ready, 1 starting, 2 policy not loaded, 3 policy unreadable, 4 policy unverified, 5 valkey unreachable, 6 shutting down.",
		}),
		scopeEval: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_scope_eval_total",
			Help: "Scope matcher evaluations by result (allow or deny).",
		}, []string{"result"}),
	}
	buildInfo := prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "egress_build_info",
		Help:        "Build information of the running gateway (always 1).",
		ConstLabels: prometheus.Labels{"version": version, "commit": commit},
	})
	buildInfo.Set(1)
	m.notReadyReason.Set(ReasonCodeStarting)
	reg.MustRegister(m.up, m.ready, m.notReadyReason, m.scopeEval, buildInfo,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// SetUp records whether the process is up.
func (m *Metrics) SetUp(up bool) { m.up.Set(boolGauge(up)) }

// SetReadiness records the readiness state and its reason code.
func (m *Metrics) SetReadiness(ready bool, reasonCode int) {
	m.ready.Set(boolGauge(ready))
	m.notReadyReason.Set(float64(reasonCode))
}

// ObserveScope counts one scope evaluation (egress_scope_eval_total{result=allow|deny}).
func (m *Metrics) ObserveScope(allow bool) {
	result := "deny"
	if allow {
		result = "allow"
	}
	m.scopeEval.WithLabelValues(result).Inc()
}

// Handler serves the registry in the Prometheus exposition format.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{Registry: m.Registry})
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// NewTracerProvider builds the OpenTelemetry tracer provider. With a non-empty
// endpoint (OTEL_EXPORTER_OTLP_ENDPOINT, the collector base URL) spans are batched
// to <endpoint>/v1/traces over OTLP/HTTP; the exporter connects lazily, so an
// unreachable collector never blocks startup. With an empty endpoint spans are
// recorded but not exported. Extra options (for example a test span recorder) are
// appended.
func NewTracerProvider(ctx context.Context, endpoint, version string, extra ...sdktrace.TracerProviderOption) (*sdktrace.TracerProvider, error) {
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		semconv.ServiceName(ServiceName),
		semconv.ServiceVersion(version),
	))
	if err != nil {
		return nil, fmt.Errorf("otel resource: %w", err)
	}
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if endpoint != "" {
		exp, err := otlptracehttp.New(ctx,
			otlptracehttp.WithEndpointURL(strings.TrimRight(endpoint, "/")+"/v1/traces"))
		if err != nil {
			return nil, fmt.Errorf("otlp trace exporter: %w", err)
		}
		opts = append(opts, sdktrace.WithBatcher(exp))
	}
	opts = append(opts, extra...)
	return sdktrace.NewTracerProvider(opts...), nil
}

// ErrNilTracerProvider is returned by FlushAndShutdown for a nil provider.
var ErrNilTracerProvider = errors.New("obs: nil tracer provider")

// FlushAndShutdown flushes pending spans and shuts the provider down within ctx.
func FlushAndShutdown(ctx context.Context, tp *sdktrace.TracerProvider) error {
	if tp == nil {
		return ErrNilTracerProvider
	}
	return errors.Join(tp.ForceFlush(ctx), tp.Shutdown(ctx))
}
