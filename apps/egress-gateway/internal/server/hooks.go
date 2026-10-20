// Package server is the egress gateway's chassis: the startup/shutdown lifecycle,
// the management plane (/healthz, /readyz, /metrics and the reserved control API
// mount) and the readiness state that keeps every data plane fail closed.
//
// The management plane and the data planes never share a listener or a mux. Data
// planes (HTTP(S) proxy, SOCKS5, DNS; EGRESS-005/007/008) plug in through the
// DataPlane interface and are started only once the gateway is ready; after that
// they must deny every request whenever Gate.Ready reports false.
//
// The typed hook points below let later EGRESS issues supply their implementations
// without refactoring the chassis. Every default implementation fails closed.
package server

import (
	"context"
	"errors"
	"time"
)

// ErrNotImplemented is returned by default hooks whose owning issue has not landed.
// Callers must treat it as a deny.
var ErrNotImplemented = errors.New("egress-gateway: not implemented in this build (fail closed)")

// PolicyState is the state of the signed policy snapshot.
type PolicyState int

// Policy states, in increasing order of trust. Only PolicyVerified allows traffic.
const (
	// PolicyNotLoaded: no snapshot present at the configured path.
	PolicyNotLoaded PolicyState = iota
	// PolicyUnreadable: a snapshot path exists but cannot be read.
	PolicyUnreadable
	// PolicyUnverified: a snapshot was read but its signature/envelope is not verified.
	PolicyUnverified
	// PolicyVerified: a signature-verified, unexpired snapshot is loaded.
	PolicyVerified
)

// PolicyStatus reports the policy snapshot state. Detail is a short, value-free
// explanation surfaced in /readyz and logs; it must never contain policy contents.
type PolicyStatus struct {
	State  PolicyState
	Detail string
}

// PolicyProvider owns the signed policy snapshot (load, verify, refresh; EGRESS-003)
// and, later, its evaluation. The chassis only asks for its status.
type PolicyProvider interface {
	PolicyStatus(ctx context.Context) PolicyStatus
}

// BudgetStore is the Valkey-backed request-budget store (EGRESS-004). The chassis
// uses Ping for the "Valkey reachable" readiness check.
type BudgetStore interface {
	Ping(ctx context.Context) error
}

// Capturer writes evidence for proxied traffic. A capture failure must block the
// request (CONTEXT_PACK §8.2). The method set grows with the capture issue.
type Capturer interface {
	Healthy(ctx context.Context) error
}

// SessionInjector injects session credentials by reference at the proxy
// (CONTEXT_PACK §8.7). The method set grows with the session-injection issue.
type SessionInjector interface {
	Healthy(ctx context.Context) error
}

// Gate is the readiness view handed to data planes.
type Gate interface {
	// Ready reports whether traffic may be evaluated at all. When false a data
	// plane must answer every request with deny.
	Ready() bool
}

// Hooks bundles the hook points handed to data planes.
type Hooks struct {
	Policy   PolicyProvider
	Budget   BudgetStore
	Capture  Capturer
	Sessions SessionInjector
}

// DataPlane is a sandbox-facing listener set (proxy, SOCKS5, DNS).
type DataPlane interface {
	// Name identifies the data plane in logs.
	Name() string
	// Start binds the listeners and begins serving. It is called at most once, and
	// only after the gateway first becomes ready. It must not block.
	Start(ctx context.Context, gate Gate, hooks Hooks) error
	// Shutdown stops accepting connections and drains in-flight ones until ctx ends.
	Shutdown(ctx context.Context) error
}

// unavailable is the fail-closed default for Capturer and SessionInjector.
type unavailable struct{}

func (unavailable) Healthy(context.Context) error { return ErrNotImplemented }

// DefaultCapturer returns the fail-closed Capturer used until the capture issue lands.
func DefaultCapturer() Capturer { return unavailable{} }

// DefaultSessionInjector returns the fail-closed SessionInjector used until the
// session-injection issue lands.
func DefaultSessionInjector() SessionInjector { return unavailable{} }

// Backoff is a capped exponential backoff used for readiness re-checks.
type Backoff struct {
	Min, Max time.Duration
	cur      time.Duration
}

// Next returns the next delay: Min, 2*Min, 4*Min, ... capped at Max.
func (b *Backoff) Next() time.Duration {
	switch {
	case b.cur == 0:
		b.cur = b.Min
	case b.cur < b.Max:
		b.cur *= 2
	}
	if b.cur > b.Max {
		b.cur = b.Max
	}
	return b.cur
}

// Reset restarts the sequence at Min.
func (b *Backoff) Reset() { b.cur = 0 }
