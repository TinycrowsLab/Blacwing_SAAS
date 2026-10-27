package httpproxy

import (
	"context"
	"net/http"

	"github.com/elazarl/goproxy"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
)

// Request is what the Authorizer decides on: the verified identity plus the
// normalised target. The Authorizer resolves the test case's intrusiveness class
// from the signed policy snapshot using Identity.TestCaseID.
type Request struct {
	Identity identity.RequestIdentity
	// Action is the Cedar action name, "http:<METHOD>".
	Action string
	Method string
	// URL is the target URL without userinfo or fragment (CONNECT: https://host:port).
	URL string
	// Scheme is "http" or, for CONNECT, "https".
	Scheme string
	// Host is the lower-case hostname or IP literal without port or brackets.
	Host string
	Port int
}

// Decision is the Authorizer's answer. Allow is the only way through; the zero
// value denies. Code and Reason are echoed to the client and must be value-free
// (no policy contents, no secrets); MatchedRule names the deciding scope/policy rule.
type Decision struct {
	Allow       bool
	Code        string
	Reason      string
	MatchedRule string
}

// Authorizer performs the per-request scope match and Cedar authorization
// (EGRESS-003/004). Any evaluation error must be returned as a deny.
type Authorizer interface {
	Authorize(ctx context.Context, req Request) Decision
}

// DenyAll is the fail-closed Authorizer used until a policy-backed one is wired.
type DenyAll struct{}

// Authorize implements Authorizer.
func (DenyAll) Authorize(context.Context, Request) Decision {
	return Decision{Code: "policy_unavailable", Reason: "no policy evaluator is configured"}
}

// BudgetGuard enforces per-identity request and byte budgets (EGRESS-010). A non-nil
// error denies the request.
type BudgetGuard interface {
	Allow(ctx context.Context, id identity.RequestIdentity, bytes int64) error
}

// SessionInjector injects session credentials by reference (EGRESS-011) into a
// request that was already authorised. A non-nil error denies the request.
type SessionInjector interface {
	Inject(req *http.Request, id identity.RequestIdentity) error
}

// Capturer records every request/response pair as evidence (EGRESS-012). A non-nil
// error blocks the response (CONTEXT_PACK §8.2).
type Capturer interface {
	OnPair(req *http.Request, resp *http.Response) error
}

// ConnectInterceptor hands an authorised CONNECT to TLS interception (EGRESS-006).
type ConnectInterceptor interface {
	Intercept(id identity.RequestIdentity, host string) *goproxy.ConnectAction
}

// Nop implements BudgetGuard, SessionInjector and Capturer by allowing everything:
// the explicit placeholder until EGRESS-010/011/012 land.
type Nop struct{}

// Allow implements BudgetGuard.
func (Nop) Allow(context.Context, identity.RequestIdentity, int64) error { return nil }

// Inject implements SessionInjector.
func (Nop) Inject(*http.Request, identity.RequestIdentity) error { return nil }

// OnPair implements Capturer.
func (Nop) OnPair(*http.Request, *http.Response) error { return nil }

// AuditEventRequestDenied is the audit event type emitted on every denied request.
const AuditEventRequestDenied = "egress.request_denied"

// DeniedEvent is the audit record of a denied request. It carries identity and rule
// names only: never the token, headers or bodies.
type DeniedEvent struct {
	Type        string
	Code        string
	MatchedRule string
	RunID       string
	SessionID   string
	TestCaseID  string
	RoleID      string
	Method      string
	TargetHost  string
	Port        int
}

// Auditor receives request-denied events.
type Auditor interface {
	RequestDenied(ctx context.Context, ev DeniedEvent) error
}
