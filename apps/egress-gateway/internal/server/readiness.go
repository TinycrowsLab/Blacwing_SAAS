package server

import (
	"context"
	"sync"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/obs"
)

// Reason is a machine-readable readiness reason.
type Reason string

// Readiness reasons. Only ReasonReady means traffic may be evaluated.
const (
	ReasonReady             Reason = "ready"
	ReasonStarting          Reason = "starting"
	ReasonPolicyNotLoaded   Reason = "policy_not_loaded"
	ReasonPolicyUnreadable  Reason = "policy_unreadable"
	ReasonPolicyUnverified  Reason = "policy_unverified"
	ReasonValkeyUnreachable Reason = "valkey_unreachable"
	ReasonShuttingDown      Reason = "shutting_down"
)

var reasonCodes = map[Reason]int{
	ReasonReady:             obs.ReasonCodeReady,
	ReasonStarting:          obs.ReasonCodeStarting,
	ReasonPolicyNotLoaded:   obs.ReasonCodePolicyNotLoaded,
	ReasonPolicyUnreadable:  obs.ReasonCodePolicyUnreadable,
	ReasonPolicyUnverified:  obs.ReasonCodePolicyUnverified,
	ReasonValkeyUnreachable: obs.ReasonCodeValkeyUnreachable,
	ReasonShuttingDown:      obs.ReasonCodeShuttingDown,
}

// Code returns the numeric code exported by egress_not_ready_reason.
func (r Reason) Code() int { return reasonCodes[r] }

// Check is the outcome of one readiness check, rendered in the /readyz body.
type Check struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// Snapshot is a consistent view of the readiness state.
type Snapshot struct {
	Ready  bool             `json:"ready"`
	Reason Reason           `json:"reason"`
	Checks map[string]Check `json:"checks"`
}

// Readiness holds the gateway's readiness state. The zero value is not ready
// (fail closed). It implements Gate.
type Readiness struct {
	mu       sync.RWMutex
	snap     Snapshot
	stopping bool
}

// NewReadiness returns a not-ready state with reason "starting".
func NewReadiness() *Readiness {
	return &Readiness{snap: Snapshot{Reason: ReasonStarting, Checks: map[string]Check{}}}
}

// Ready implements Gate.
func (r *Readiness) Ready() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.snap.Ready
}

// Snapshot returns a copy of the current state.
func (r *Readiness) Snapshot() Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	checks := make(map[string]Check, len(r.snap.Checks))
	for k, v := range r.snap.Checks {
		checks[k] = v
	}
	return Snapshot{Ready: r.snap.Ready, Reason: r.snap.Reason, Checks: checks}
}

// set stores s unless shutdown has begun; it reports the stored snapshot and
// whether readiness changed.
func (r *Readiness) set(s Snapshot) (Snapshot, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopping {
		return r.snap, false
	}
	changed := s.Ready != r.snap.Ready || s.Reason != r.snap.Reason
	r.snap = s
	return s, changed
}

// shutdown latches the not-ready "shutting_down" state; later sets are ignored.
func (r *Readiness) shutdown() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopping = true
	r.snap = Snapshot{Ready: false, Reason: ReasonShuttingDown, Checks: r.snap.Checks}
	return r.snap
}

// evaluate runs every readiness check once. Config is valid by construction (the
// gateway never starts with invalid config). The first failing check, in the
// order config, policy, valkey, becomes the reason.
func evaluate(ctx context.Context, policy PolicyProvider, budget BudgetStore) Snapshot {
	checks := map[string]Check{"config": {OK: true}}
	reason := ReasonReady

	ps := policy.PolicyStatus(ctx)
	checks["policy"] = Check{OK: ps.State == PolicyVerified, Detail: ps.Detail}
	if ps.State != PolicyVerified {
		switch ps.State {
		case PolicyUnreadable:
			reason = ReasonPolicyUnreadable
		case PolicyUnverified:
			reason = ReasonPolicyUnverified
		default:
			reason = ReasonPolicyNotLoaded
		}
	}

	if err := budget.Ping(ctx); err != nil {
		checks["valkey"] = Check{OK: false, Detail: err.Error()}
		if reason == ReasonReady {
			reason = ReasonValkeyUnreachable
		}
	} else {
		checks["valkey"] = Check{OK: true}
	}
	return Snapshot{Ready: reason == ReasonReady, Reason: reason, Checks: checks}
}
