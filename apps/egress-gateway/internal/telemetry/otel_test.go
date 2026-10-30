package telemetry

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
)

// collector records the OTLP/HTTP paths and bodies it receives.
type collector struct {
	mu     sync.Mutex
	bodies map[string][]byte
}

func (c *collector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bodies == nil {
		c.bodies = map[string][]byte{}
	}
	c.bodies[r.URL.Path] = append(c.bodies[r.URL.Path], body...)
	w.WriteHeader(http.StatusOK)
}

func (c *collector) get(path string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return bytes.Clone(c.bodies[path])
}

func TestSetupWithoutEndpointRecordsWithoutExporting(t *testing.T) {
	ctx := context.Background()
	tel, err := Setup(ctx, "", "test")
	require.NoError(t, err)
	require.NotNil(t, tel.Tracer)
	require.NotNil(t, tel.Meter)
	_, span := tel.Tracer.Tracer("test").Start(ctx, "egress.noop")
	span.End()
	assert.NoError(t, tel.Shutdown(ctx))
}

func TestSetupExportsTracesAndMetricsWithServiceName(t *testing.T) {
	col := &collector{}
	srv := httptest.NewServer(col)
	t.Cleanup(srv.Close)

	ctx := context.Background()
	tel, err := Setup(ctx, srv.URL+"/", "test")
	require.NoError(t, err)

	_, span := tel.Tracer.Tracer("test").Start(ctx, "egress.startup")
	span.End()
	counter, err := tel.Meter.Meter("test").Int64Counter("egress.http.requests")
	require.NoError(t, err)
	counter.Add(ctx, 1)
	require.NoError(t, tel.Shutdown(ctx))

	// The OTLP protobuf encoding carries strings verbatim, so the resource and names are
	// found byte-for-byte in the exported payloads.
	traces := col.get("/v1/traces")
	assert.Contains(t, string(traces), "egress.startup")
	assert.Contains(t, string(traces), "egress-gateway", "service.name must be egress-gateway")
	metricsBody := col.get("/v1/metrics")
	assert.Contains(t, string(metricsBody), "egress.http.requests")
	assert.Contains(t, string(metricsBody), "egress-gateway")
}

func TestSetupInstallsGlobalProvidersAndW3CPropagation(t *testing.T) {
	ctx := context.Background()
	tel, err := Setup(ctx, "", "test")
	require.NoError(t, err)
	t.Cleanup(func() { _ = tel.Shutdown(ctx) })

	assert.Equal(t, tel.Tracer, otel.GetTracerProvider())
	assert.Equal(t, tel.Meter, otel.GetMeterProvider())
	fields := otel.GetTextMapPropagator().Fields()
	assert.Contains(t, fields, "traceparent")
	assert.Contains(t, fields, "baggage")
}
