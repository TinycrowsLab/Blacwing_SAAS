package obs_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

func TestLoggerEmitsContractFields(t *testing.T) {
	var buf bytes.Buffer
	l := obs.WithRun(obs.Component(obs.NewLogger(&buf, slog.LevelDebug, "1.2.3"), obs.ComponentBootstrap), "run_01", "ses_01")
	l.Debug("hello")

	var m map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &m))
	for k, want := range map[string]any{
		"level": "DEBUG", "msg": "hello", "component": "bootstrap", "run_id": "run_01",
		"session_id": "ses_01", "service": "egress-gateway", "version": "1.2.3",
	} {
		assert.Equal(t, want, m[k], k)
	}
	assert.NotContains(t, m, "time")
	ts, ok := m["ts"].(string)
	require.True(t, ok)
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	require.NoError(t, err)
	assert.Equal(t, time.UTC, parsed.Location())
	assert.True(t, strings.HasSuffix(ts, "Z"))
}

func TestLoggerHonoursLevel(t *testing.T) {
	var buf bytes.Buffer
	l := obs.NewLogger(&buf, slog.LevelWarn, "v")
	l.Info("dropped")
	assert.Empty(t, buf.String())
}

// Edge case: clock skew must not affect durations. time.Now carries a monotonic
// reading ("m=" in its String form) and Elapsed never goes negative.
func TestStopwatchUsesMonotonicClock(t *testing.T) {
	sw := obs.StartStopwatch()
	time.Sleep(5 * time.Millisecond)
	assert.GreaterOrEqual(t, sw.Elapsed(), 5*time.Millisecond)
	assert.Contains(t, time.Now().String(), "m=", "runtime provides a monotonic reading")
}

func TestMetricsExposeCoreGauges(t *testing.T) {
	m := obs.NewMetrics("1.2.3", "deadbeef")
	scrape := func() string {
		rr := httptest.NewRecorder()
		m.Handler().ServeHTTP(rr, httptest.NewRequest("GET", "/metrics", nil))
		b, err := io.ReadAll(rr.Body)
		require.NoError(t, err)
		return string(b)
	}
	out := scrape()
	assert.Contains(t, out, `egress_build_info{commit="deadbeef",version="1.2.3"} 1`)
	assert.Contains(t, out, "egress_up 0")
	assert.Contains(t, out, "egress_ready 0")
	assert.Contains(t, out, "egress_not_ready_reason 1")
	assert.Contains(t, out, "go_goroutines")

	m.SetUp(true)
	m.SetReadiness(true, obs.ReasonCodeReady)
	out = scrape()
	assert.Contains(t, out, "egress_up 1")
	assert.Contains(t, out, "egress_ready 1")
	assert.Contains(t, out, "egress_not_ready_reason 0")
}

func TestTracerProviderWithoutEndpointRecordsLocally(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp, err := obs.NewTracerProvider(context.Background(), "", "v", sdktrace.WithSpanProcessor(rec))
	require.NoError(t, err)
	_, span := tp.Tracer("t").Start(context.Background(), "gateway.startup")
	span.End()
	require.Len(t, rec.Ended(), 1)
	assert.NoError(t, obs.FlushAndShutdown(context.Background(), tp))
	assert.ErrorIs(t, obs.FlushAndShutdown(context.Background(), nil), obs.ErrNilTracerProvider)
}

// The OTLP exporter connects lazily: an unreachable collector never blocks startup,
// and shutdown is bounded by its context.
func TestTracerProviderWithUnreachableEndpointDoesNotBlock(t *testing.T) {
	tp, err := obs.NewTracerProvider(context.Background(), "http://127.0.0.1:1/", "v")
	require.NoError(t, err)
	_, span := tp.Tracer("t").Start(context.Background(), "gateway.startup")
	span.End()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	sw := obs.StartStopwatch()
	_ = obs.FlushAndShutdown(ctx, tp) // export fails offline; only boundedness matters
	assert.Less(t, sw.Elapsed(), 3*time.Second)
}
