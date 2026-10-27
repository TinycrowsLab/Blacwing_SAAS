// Package dnsresolve is the egress gateway's scoped DNS resolver and the
// anti-DNS-rebinding control of CONTEXT_PACK §8.2.
//
// A name is resolved once per pin key (a run or connection), the chosen IP is pinned
// for GATEWAY_DNS_PIN_TTL, and every later lookup for the same key and name returns
// that IP without asking the upstream again. The connecting component (HTTP proxy,
// SOCKS5) must dial the IP returned by Resolve and never resolve the hostname a
// second time: that, not the cache, is the defence.
//
// Every failure denies. A name outside the run's scope is refused before any
// upstream query is made, an answer in a blocked range (see package netrange) is
// refused unless the scope names that exact IP or CIDR, and an upstream error is
// ErrResolveFailed. Pins are keyed by pin key, so one run can never read another
// run's pin (§8.6); Release drops a key's pins when its run or connection ends.
package dnsresolve

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/net/idna"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/netrange"
	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

// Errors returned by Resolve. Callers match them with errors.Is.
var (
	// ErrHostOutOfScope means the name (or, with strict CNAME checking, a name in its
	// CNAME chain) is not in the run's scope. No upstream query is made for the
	// requested name.
	ErrHostOutOfScope = errors.New("dnsresolve: host out of scope")
	// ErrBlockedRange means the resolved IP is in a blocked range and not explicitly
	// in scope.
	ErrBlockedRange = errors.New("dnsresolve: resolved address in a blocked range")
	// ErrResolveFailed means the upstream timed out, answered with an error, or gave
	// no usable address. The caller must deny.
	ErrResolveFailed = errors.New("dnsresolve: resolution failed")
)

// Reasons carried by the egress.dns_blocked audit event and egress_dns_blocked_total.
const (
	ReasonOutOfScope   = "host_out_of_scope"
	ReasonCNAMEScope   = "cname_out_of_scope"
	ReasonBlockedRange = "blocked_range"
)

// AuditDNSBlocked is the audit event type for a blocked resolution.
const AuditDNSBlocked = "egress.dns_blocked"

// errCNAMEScope is query's internal signal that a CNAME chain left the scope.
var errCNAMEScope = errors.New("cname out of scope")

const (
	maxCNAMEHops = 8
	maxPins      = 100_000
	// DefaultTimeout bounds each upstream exchange.
	DefaultTimeout = 5 * time.Second
)

// Scope answers the two questions the resolver needs from the run's envelope scope
// (the scope matcher of EGRESS-004 satisfies it).
type Scope interface {
	// HostInScope reports whether the normalised (lower-case, ASCII) name is in scope.
	HostInScope(host string) bool
	// IPInScope reports whether the scope explicitly names this IP or a CIDR that
	// contains it. A hostname rule never makes an IP "in scope" here.
	IPInScope(ip netip.Addr) bool
}

// Exchanger sends one DNS query to an upstream server. *dns.Client satisfies it.
type Exchanger interface {
	ExchangeContext(ctx context.Context, m *dns.Msg, addr string) (*dns.Msg, time.Duration, error)
}

// BlockedEvent describes one blocked resolution for the audit trail. IPHash is a
// truncated SHA-256 of the resolved IP (empty when none was resolved); the IP itself
// is never recorded.
type BlockedEvent struct {
	Host   string
	Reason string
	IPHash string
}

// Auditor receives egress.dns_blocked events.
type Auditor interface {
	DNSBlocked(ctx context.Context, ev BlockedEvent) error
}

// LogAuditor writes blocked events to a logger with component=audit.
type LogAuditor struct{ Logger *slog.Logger }

// DNSBlocked implements Auditor.
func (a LogAuditor) DNSBlocked(ctx context.Context, ev BlockedEvent) error {
	attrs := []slog.Attr{
		slog.String("event", AuditDNSBlocked),
		slog.String("host", ev.Host),
		slog.String("reason", ev.Reason),
	}
	if ev.IPHash != "" {
		attrs = append(attrs, slog.String("ip_hash", ev.IPHash))
	}
	obs.Component(a.Logger, obs.ComponentAudit).LogAttrs(ctx, slog.LevelInfo, "audit event", attrs...)
	return nil
}

// Options configures a Resolver.
type Options struct {
	// Scope decides which names and IPs are allowed. Required.
	Scope Scope
	// Upstream is the host:port of the upstream DNS server (GATEWAY_DNS_UPSTREAM).
	// Empty uses the first nameserver of /etc/resolv.conf.
	Upstream string
	// PinTTL is how long a pin lives (GATEWAY_DNS_PIN_TTL). Must be positive.
	PinTTL time.Duration
	// StrictCNAME requires every name in a CNAME chain to be in scope
	// (GATEWAY_DNS_STRICT_CNAME). The final IP is always validated.
	StrictCNAME bool
	// Timeout bounds each upstream exchange; zero means DefaultTimeout.
	Timeout time.Duration
	// Exchanger overrides the upstream transport (tests); nil uses UDP with TCP
	// fallback on truncation.
	Exchanger Exchanger
	// Logger receives component=dns logs; nil discards them.
	Logger *slog.Logger
	// Metrics receives counters; nil keeps private, unregistered ones.
	Metrics *Metrics
	// Audit receives egress.dns_blocked events; nil logs them via Logger.
	Audit Auditor
	// Tracer records the dns.resolve span; nil uses the global provider.
	Tracer trace.Tracer
	// Now overrides the clock for pin expiry (tests).
	Now func() time.Time
}

type pin struct {
	ip      netip.Addr
	expires time.Time
}

// Resolver resolves names once, pins the result and enforces scope and ranges.
type Resolver struct {
	opts   Options
	log    *slog.Logger
	tracer trace.Tracer

	mu    sync.Mutex
	pins  map[string]map[string]pin // pinKey -> normalised host -> pin
	count int
}

// New validates opts and returns a Resolver.
func New(opts Options) (*Resolver, error) {
	if opts.Scope == nil {
		return nil, errors.New("dnsresolve: Scope is required")
	}
	if opts.PinTTL <= 0 {
		return nil, errors.New("dnsresolve: PinTTL must be positive")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.Upstream == "" {
		up, err := systemUpstream()
		if err != nil {
			return nil, err
		}
		opts.Upstream = up
	}
	if opts.Exchanger == nil {
		opts.Exchanger = &udpTCPExchanger{timeout: opts.Timeout}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Metrics == nil {
		opts.Metrics = NewMetrics(nil)
	}
	if opts.Audit == nil {
		opts.Audit = LogAuditor{Logger: opts.Logger}
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	tr := opts.Tracer
	if tr == nil {
		tr = otel.Tracer("egress-gateway/dns")
	}
	return &Resolver{
		opts:   opts,
		log:    obs.Component(opts.Logger, obs.ComponentDNS),
		tracer: tr,
		pins:   make(map[string]map[string]pin),
	}, nil
}

func systemUpstream() (string, error) {
	cc, err := dns.ClientConfigFromFile("/etc/resolv.conf")
	if err != nil || len(cc.Servers) == 0 {
		return "", errors.New("dnsresolve: no system nameserver in /etc/resolv.conf")
	}
	return net.JoinHostPort(cc.Servers[0], cc.Port), nil
}

// udpTCPExchanger queries over UDP and retries over TCP when the answer is truncated.
type udpTCPExchanger struct{ timeout time.Duration }

func (e *udpTCPExchanger) ExchangeContext(ctx context.Context, m *dns.Msg, addr string) (*dns.Msg, time.Duration, error) {
	udp := &dns.Client{Net: "udp", Timeout: e.timeout}
	r, rtt, err := udp.ExchangeContext(ctx, m, addr)
	if err == nil && r != nil && r.Truncated {
		tcp := &dns.Client{Net: "tcp", Timeout: e.timeout}
		return tcp.ExchangeContext(ctx, m, addr)
	}
	return r, rtt, err
}

// Resolve returns the IP the caller must dial for host under pinKey. The first call
// resolves upstream and pins; later calls within PinTTL return the same IP.
func (r *Resolver) Resolve(ctx context.Context, host, pinKey string) (net.IP, error) {
	ctx, span := r.tracer.Start(ctx, "dns.resolve")
	defer span.End()
	ctx, cancel := context.WithTimeout(ctx, 3*r.opts.Timeout)
	defer cancel()

	name, err := normalize(host)
	if err != nil {
		return nil, r.deny(ctx, span, host, ReasonOutOfScope, netip.Addr{}, ErrHostOutOfScope)
	}
	span.SetAttributes(attribute.String("dns.host", name))
	if !r.opts.Scope.HostInScope(name) {
		return nil, r.deny(ctx, span, name, ReasonOutOfScope, netip.Addr{}, ErrHostOutOfScope)
	}

	if ip, ok := r.pinned(pinKey, name); ok {
		if err := r.admit(ip); err != nil {
			return nil, r.deny(ctx, span, name, ReasonBlockedRange, ip, err)
		}
		r.opts.Metrics.pinHits.Inc()
		return r.done(ctx, span, name, ip, "pin_hit"), nil
	}

	ip, reason, err := r.lookup(ctx, name)
	if err == nil {
		err = r.admit(ip)
		reason = ReasonBlockedRange
	}
	if err != nil {
		if errors.Is(err, ErrResolveFailed) {
			r.opts.Metrics.queries.WithLabelValues("failed").Inc()
			r.log.LogAttrs(ctx, slog.LevelWarn, "resolution failed",
				slog.String("host", name), slog.String("result", "failed"))
			span.SetStatus(codes.Error, "resolve failed")
			return nil, err
		}
		return nil, r.deny(ctx, span, name, reason, ip, err)
	}
	ip, err = r.store(pinKey, name, ip)
	if err != nil {
		r.opts.Metrics.queries.WithLabelValues("failed").Inc()
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}
	return r.done(ctx, span, name, ip, "pinned"), nil
}

// Release drops every pin held under pinKey (run or connection ended).
func (r *Resolver) Release(pinKey string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.count -= len(r.pins[pinKey])
	delete(r.pins, pinKey)
}

func (r *Resolver) done(ctx context.Context, span trace.Span, host string, ip netip.Addr, result string) net.IP {
	r.opts.Metrics.queries.WithLabelValues(result).Inc()
	r.log.LogAttrs(ctx, slog.LevelDebug, "resolved",
		slog.String("host", host), slog.String("pinned_ip", ip.String()), slog.String("result", result))
	span.SetAttributes(attribute.String("dns.result", result))
	return net.IP(ip.AsSlice())
}

// deny records a blocked resolution in metrics, logs, the span and the audit trail.
func (r *Resolver) deny(ctx context.Context, span trace.Span, host, reason string, ip netip.Addr, err error) error {
	r.opts.Metrics.queries.WithLabelValues("blocked").Inc()
	r.opts.Metrics.blocked.WithLabelValues(reason).Inc()
	r.log.LogAttrs(ctx, slog.LevelWarn, "resolution blocked",
		slog.String("host", host), slog.String("result", "blocked"), slog.String("reason", reason))
	span.SetStatus(codes.Error, reason)
	ev := BlockedEvent{Host: host, Reason: reason}
	if ip.IsValid() {
		sum := sha256.Sum256([]byte(ip.String()))
		ev.IPHash = hex.EncodeToString(sum[:8])
	}
	if aerr := r.opts.Audit.DNSBlocked(ctx, ev); aerr != nil {
		r.log.LogAttrs(ctx, slog.LevelError, "audit emit failed", slog.String("event", AuditDNSBlocked))
	}
	return err
}

// admit rejects an IP in a blocked range unless the scope explicitly names it.
func (r *Resolver) admit(ip netip.Addr) error {
	if netrange.IsBlocked(ip) && !r.opts.Scope.IPInScope(ip.Unmap()) {
		return ErrBlockedRange
	}
	return nil
}

func (r *Resolver) pinned(pinKey, host string) (netip.Addr, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.pins[pinKey][host]
	if !ok {
		return netip.Addr{}, false
	}
	if !r.opts.Now().Before(p.expires) {
		r.drop(pinKey, host)
		return netip.Addr{}, false
	}
	return p.ip, true
}

// store pins ip unless a concurrent resolution pinned first, in which case the
// earlier pin wins so the caller never sees two IPs for one key and name.
func (r *Resolver) store(pinKey, host string, ip netip.Addr) (netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.opts.Now()
	if p, ok := r.pins[pinKey][host]; ok && now.Before(p.expires) {
		return p.ip, nil
	}
	if r.count >= maxPins {
		r.pruneExpired(now)
		if r.count >= maxPins {
			return netip.Addr{}, fmt.Errorf("%w: pin cache full", ErrResolveFailed)
		}
	}
	if r.pins[pinKey] == nil {
		r.pins[pinKey] = make(map[string]pin)
	}
	if _, exists := r.pins[pinKey][host]; !exists {
		r.count++
	}
	r.pins[pinKey][host] = pin{ip: ip, expires: now.Add(r.opts.PinTTL)}
	return ip, nil
}

func (r *Resolver) drop(pinKey, host string) {
	delete(r.pins[pinKey], host)
	r.count--
	if len(r.pins[pinKey]) == 0 {
		delete(r.pins, pinKey)
	}
}

func (r *Resolver) pruneExpired(now time.Time) {
	for k, hosts := range r.pins {
		for h, p := range hosts {
			if !now.Before(p.expires) {
				r.drop(k, h)
			}
		}
	}
}

// normalize lower-cases the name, strips a trailing dot and converts IDN labels to
// their ASCII form so the scope check and the upstream query see the same name.
func normalize(host string) (string, error) {
	h := strings.TrimSuffix(strings.TrimSpace(host), ".")
	if h == "" {
		return "", errors.New("empty host")
	}
	if ip, err := netip.ParseAddr(h); err == nil {
		return ip.Unmap().String(), nil
	}
	a, err := idna.Lookup.ToASCII(h)
	if err != nil || a == "" {
		return "", errors.New("invalid host")
	}
	return strings.ToLower(a), nil
}

// lookup resolves name upstream and returns the single IP to pin: the first address
// after sorting (IPv4 before IPv6), so the choice is deterministic. The reason is
// meaningful only with a non-nil error.
func (r *Resolver) lookup(ctx context.Context, name string) (netip.Addr, string, error) {
	if ip, err := netip.ParseAddr(name); err == nil {
		return ip, "", nil // an IP literal needs no resolution
	}
	cur := name
	seen := map[string]bool{}
	for range maxCNAMEHops {
		if seen[cur] {
			return netip.Addr{}, "", fmt.Errorf("%w: CNAME loop", ErrResolveFailed)
		}
		seen[cur] = true
		addrs, final, err := r.query(ctx, cur)
		if errors.Is(err, errCNAMEScope) {
			return netip.Addr{}, ReasonCNAMEScope, ErrHostOutOfScope
		}
		if err != nil {
			return netip.Addr{}, "", err
		}
		if len(addrs) > 0 {
			slices.SortFunc(addrs, netip.Addr.Compare)
			return addrs[0], "", nil
		}
		if final == cur {
			return netip.Addr{}, "", fmt.Errorf("%w: no address records", ErrResolveFailed)
		}
		cur = final
	}
	return netip.Addr{}, "", fmt.Errorf("%w: CNAME chain too long", ErrResolveFailed)
}

// query asks for A and AAAA of name, follows the CNAME chain in the answer and
// returns the addresses owned by the end of that chain together with its name.
// Records not reachable from name through the chain are ignored, so a poisoned
// answer cannot smuggle in an address for an unrelated name. In strict mode every
// name in the chain is checked here.
func (r *Resolver) query(ctx context.Context, name string) ([]netip.Addr, string, error) {
	cnames := map[string]string{}
	owned := map[string][]netip.Addr{}
	for _, qt := range []uint16{dns.TypeA, dns.TypeAAAA} {
		m := new(dns.Msg)
		m.SetQuestion(dns.Fqdn(name), qt)
		m.RecursionDesired = true
		qctx, cancel := context.WithTimeout(ctx, r.opts.Timeout)
		resp, _, err := r.opts.Exchanger.ExchangeContext(qctx, m, r.opts.Upstream)
		cancel()
		if err != nil {
			return nil, "", fmt.Errorf("%w: %w", ErrResolveFailed, err)
		}
		if resp == nil || resp.Rcode != dns.RcodeSuccess {
			rc := "no response"
			if resp != nil {
				rc = dns.RcodeToString[resp.Rcode]
			}
			return nil, "", fmt.Errorf("%w: upstream rcode %s", ErrResolveFailed, rc)
		}
		for _, rr := range resp.Answer {
			owner := strings.ToLower(strings.TrimSuffix(rr.Header().Name, "."))
			switch v := rr.(type) {
			case *dns.CNAME:
				cnames[owner] = strings.ToLower(strings.TrimSuffix(v.Target, "."))
			case *dns.A:
				if ip, ok := netip.AddrFromSlice(v.A); ok {
					owned[owner] = append(owned[owner], ip.Unmap())
				}
			case *dns.AAAA:
				if ip, ok := netip.AddrFromSlice(v.AAAA); ok {
					owned[owner] = append(owned[owner], ip.Unmap())
				}
			}
		}
	}
	cur := name
	for range maxCNAMEHops {
		next, ok := cnames[cur]
		if !ok {
			break
		}
		cur = next
		if r.opts.StrictCNAME && !r.opts.Scope.HostInScope(cur) {
			return nil, "", errCNAMEScope
		}
	}
	if _, more := cnames[cur]; more {
		return nil, "", fmt.Errorf("%w: CNAME chain too long", ErrResolveFailed)
	}
	return owned[cur], cur, nil
}
