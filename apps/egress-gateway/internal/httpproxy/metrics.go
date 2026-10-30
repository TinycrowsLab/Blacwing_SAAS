package httpproxy

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Decision label values of egress_http_requests_total.
const (
	decisionAllow           = "allow"
	decisionDeny            = "deny"
	decisionUnauthenticated = "unauthenticated"
	decisionUnavailable     = "unavailable"
)

// Upstream error code label values of egress_http_upstream_errors_total.
const (
	upstreamRefused  = "refused"
	upstreamTimeout  = "timeout"
	upstreamCanceled = "canceled"
	upstreamError    = "error"
)

var knownMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"}

type metrics struct {
	requests *prometheus.CounterVec
	upstream *prometheus.CounterVec
	duration prometheus.Histogram
	// otelRequests is the OTLP twin of requests (egress.http.requests), exported with
	// the same bounded decision and method labels.
	otelRequests metric.Int64Counter
}

func newMetrics(reg prometheus.Registerer, meter metric.Meter) (*metrics, error) {
	m := &metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_http_requests_total",
			Help: "HTTP proxy requests by decision and method (unknown methods are OTHER).",
		}, []string{"decision", "method"}),
		upstream: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_http_upstream_errors_total",
			Help: "Upstream failures answered with 502/504, by code. Not retried.",
		}, []string{"code"}),
		duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "egress_http_duration_seconds",
			Help:    "Time from receiving a proxy request to its response headers (CONNECT: to the tunnel decision).",
			Buckets: prometheus.DefBuckets,
		}),
	}
	otelRequests, err := meter.Int64Counter("egress.http.requests",
		metric.WithDescription("HTTP proxy requests by decision and method (unknown methods are OTHER)."))
	if err != nil {
		return nil, err
	}
	m.otelRequests = otelRequests
	for _, d := range []string{decisionAllow, decisionDeny, decisionUnauthenticated, decisionUnavailable} {
		for _, meth := range append([]string{"OTHER"}, knownMethods...) {
			m.requests.WithLabelValues(d, meth)
		}
	}
	for _, c := range []string{upstreamRefused, upstreamTimeout, upstreamCanceled, upstreamError} {
		m.upstream.WithLabelValues(c)
	}
	if reg != nil {
		for _, c := range []prometheus.Collector{m.requests, m.upstream, m.duration} {
			if err := reg.Register(c); err != nil {
				return nil, err
			}
		}
	}
	return m, nil
}

// countRequest counts one proxy request on both the Prometheus and the OTLP counter.
// method must already be bounded by methodLabel.
func (m *metrics) countRequest(decision, method string) {
	m.requests.WithLabelValues(decision, method).Inc()
	m.otelRequests.Add(context.Background(), 1, metric.WithAttributes(
		attribute.String("decision", decision), attribute.String("method", method)))
}

// methodLabel bounds metric cardinality: attacker-chosen methods collapse to OTHER.
func methodLabel(method string) string {
	for _, m := range knownMethods {
		if m == method {
			return m
		}
	}
	return "OTHER"
}
