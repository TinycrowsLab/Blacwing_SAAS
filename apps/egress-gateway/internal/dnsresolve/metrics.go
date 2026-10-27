package dnsresolve

import "github.com/prometheus/client_golang/prometheus"

// Metrics are the resolver's Prometheus counters.
type Metrics struct {
	queries *prometheus.CounterVec
	blocked *prometheus.CounterVec
	pinHits prometheus.Counter
}

// NewMetrics creates the counters and registers them on reg (nil leaves them
// unregistered, for tests).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		queries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_dns_queries_total",
			Help: "Scoped DNS resolutions by result: pinned, pin_hit, blocked, failed.",
		}, []string{"result"}),
		blocked: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_dns_blocked_total",
			Help: "Blocked DNS resolutions by reason: host_out_of_scope, cname_out_of_scope, blocked_range.",
		}, []string{"reason"}),
		pinHits: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "egress_dns_pin_hits_total",
			Help: "Resolutions answered from an existing pin.",
		}),
	}
	if reg != nil {
		reg.MustRegister(m.queries, m.blocked, m.pinHits)
	}
	return m
}
