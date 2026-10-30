// Package telemetry starts the gateway's OpenTelemetry SDK (OBS-002, #299): OTLP/HTTP
// trace and metric exporters, the W3C tracecontext and baggage propagators, and the
// global providers that instrumented code reads. Every signal carries
// service.name=egress-gateway (obs.ServiceName). Only metadata is recorded: nothing
// here captures request or response bodies or headers (CONTEXT_PACK §8.7).
package telemetry

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

// Providers are the SDK providers Setup installed as the process globals.
type Providers struct {
	Tracer *sdktrace.TracerProvider
	Meter  *sdkmetric.MeterProvider
}

// Setup builds the trace and metric providers, registers them globally, and sets the
// W3C tracecontext and baggage propagators, so both Node and Go services share one
// trace context. With a non-empty endpoint (OTEL_EXPORTER_OTLP_ENDPOINT, the collector
// base URL) spans go to <endpoint>/v1/traces and metrics to <endpoint>/v1/metrics. The
// exporters connect lazily, so an unreachable collector never blocks startup. With an
// empty endpoint signals are recorded but not exported.
func Setup(ctx context.Context, endpoint, version string) (*Providers, error) {
	tp, err := obs.NewTracerProvider(ctx, endpoint, version)
	if err != nil {
		return nil, err
	}
	res, err := obs.Resource(version)
	if err != nil {
		return nil, errors.Join(err, tp.Shutdown(ctx))
	}
	meterOpts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	if endpoint != "" {
		exp, err := otlpmetrichttp.New(ctx,
			otlpmetrichttp.WithEndpointURL(strings.TrimRight(endpoint, "/")+"/v1/metrics"))
		if err != nil {
			return nil, errors.Join(fmt.Errorf("otlp metric exporter: %w", err), tp.Shutdown(ctx))
		}
		meterOpts = append(meterOpts, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp)))
	}
	mp := sdkmetric.NewMeterProvider(meterOpts...)

	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	return &Providers{Tracer: tp, Meter: mp}, nil
}

// Shutdown flushes pending spans and metrics and stops both providers within ctx.
func (p *Providers) Shutdown(ctx context.Context) error {
	return errors.Join(obs.FlushAndShutdown(ctx, p.Tracer), p.Meter.Shutdown(ctx))
}
