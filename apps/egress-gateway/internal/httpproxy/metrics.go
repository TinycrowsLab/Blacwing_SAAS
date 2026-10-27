package httpproxy

import (
	"github.com/prometheus/client_golang/prometheus"
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
}

func newMetrics(reg prometheus.Registerer) (*metrics, error) {
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

// methodLabel bounds metric cardinality: attacker-chosen methods collapse to OTHER.
func methodLabel(method string) string {
	for _, m := range knownMethods {
		if m == method {
			return m
		}
	}
	return "OTHER"
}
