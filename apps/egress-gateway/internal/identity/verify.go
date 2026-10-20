package identity

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// TokenClaims is what a TokenVerifier knows about a live token: the run and
// session it was minted for (both required), optionally the test case, and when
// it expires.
type TokenClaims struct {
	RunID      uuid.UUID
	SessionID  uuid.UUID
	TestCaseID uuid.UUID // uuid.Nil: not bound to a single test case
	ExpiresAt  time.Time
}

// TokenVerifier confirms that id.Token is live, unrevoked and bound to the same
// run/session as id. It returns ErrTokenInvalid (unknown or mismatched),
// ErrTokenRevoked or ErrTokenExpired, or any other error when the backend cannot
// answer; the Authenticator treats every error as deny. Implementations must
// compare tokens in constant time (see TokensEqual). The production implementation
// is backed by Valkey and the Run Broker (EGRESS-010).
type TokenVerifier interface {
	Verify(ctx context.Context, id RequestIdentity) (TokenClaims, error)
}

// ErrVerifierUnavailable is returned by UnavailableVerifier.
var ErrVerifierUnavailable = errors.New("token verifier unavailable")

// UnavailableVerifier is the fail-closed default verifier: it rejects every token.
type UnavailableVerifier struct{}

// Verify implements TokenVerifier.
func (UnavailableVerifier) Verify(context.Context, RequestIdentity) (TokenClaims, error) {
	return TokenClaims{}, ErrVerifierUnavailable
}

// TokensEqual compares two tokens in constant time with respect to their content
// and length (both are hashed to fixed-size digests first).
func TokensEqual(a, b string) bool {
	ha, hb := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// StaticVerifier is an in-memory TokenVerifier for tests and the local dev stack
// until the Valkey-backed verifier lands with EGRESS-010. Tokens are indexed by
// their SHA-256 digest and then compared in constant time, so lookups leak no
// timing information about the token.
type StaticVerifier struct {
	// Now is the clock; nil means time.Now.
	Now func() time.Time

	mu     sync.RWMutex
	tokens map[[sha256.Size]byte]staticEntry
}

type staticEntry struct {
	token   string
	claims  TokenClaims
	revoked bool
}

// Add registers a live token with its claims.
func (v *StaticVerifier) Add(token string, claims TokenClaims) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.tokens == nil {
		v.tokens = make(map[[sha256.Size]byte]staticEntry)
	}
	v.tokens[sha256.Sum256([]byte(token))] = staticEntry{token: token, claims: claims}
}

// Revoke marks a token revoked (for example on kill, EGRESS-013).
func (v *StaticVerifier) Revoke(token string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	k := sha256.Sum256([]byte(token))
	if e, ok := v.tokens[k]; ok {
		e.revoked = true
		v.tokens[k] = e
	}
}

// Verify implements TokenVerifier.
func (v *StaticVerifier) Verify(_ context.Context, id RequestIdentity) (TokenClaims, error) {
	v.mu.RLock()
	e, ok := v.tokens[sha256.Sum256([]byte(id.Token))]
	v.mu.RUnlock()
	if !ok || !TokensEqual(e.token, id.Token) {
		return TokenClaims{}, ErrTokenInvalid
	}
	if e.revoked {
		return TokenClaims{}, ErrTokenRevoked
	}
	now := time.Now
	if v.Now != nil {
		now = v.Now
	}
	if !e.claims.ExpiresAt.After(now()) {
		return TokenClaims{}, ErrTokenExpired
	}
	if id.RunID != uuid.Nil && id.RunID != e.claims.RunID {
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonRunMismatch)
	}
	if id.SessionID != uuid.Nil && id.SessionID != e.claims.SessionID {
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonSessionMismatch)
	}
	return e.claims, nil
}

// AuditEventIdentityRejected is the audit event type emitted on every denial.
const AuditEventIdentityRejected = "egress.identity_rejected"

// RejectionEvent is the audit record of a denied identity. It never carries the
// token, only its SHA-256 prefix. Run/session/test case are empty when unparseable.
type RejectionEvent struct {
	Type              string
	Reason            Reason
	RunID             string
	SessionID         string
	TestCaseID        string
	TokenSHA256Prefix string
}

// Auditor receives identity rejection events.
type Auditor interface {
	IdentityRejected(ctx context.Context, ev RejectionEvent) error
}

// LogAuditor writes rejection events as structured logs with component=audit; the
// packages/audit ledger sink replaces it when the gateway's audit transport lands.
type LogAuditor struct{ Logger *slog.Logger }

// IdentityRejected implements Auditor.
func (a LogAuditor) IdentityRejected(ctx context.Context, ev RejectionEvent) error {
	a.Logger.LogAttrs(ctx, slog.LevelInfo, "audit event",
		slog.String("component", "audit"),
		slog.String("event", ev.Type),
		slog.String("reason", string(ev.Reason)),
		slog.String("run_id", ev.RunID),
		slog.String("session_id", ev.SessionID),
		slog.String("test_case_id", ev.TestCaseID),
		slog.String("token_sha256_prefix", ev.TokenSHA256Prefix),
	)
	return nil
}

// Component is the log component value of this package.
const Component = "identity"

// Options configures an Authenticator. Zero values are safe: a nil Verifier
// rejects everything, a nil Registerer skips metric registration.
type Options struct {
	Verifier   TokenVerifier
	Logger     *slog.Logger
	Auditor    Auditor
	Registerer prometheus.Registerer
	Tracer     trace.Tracer
	Now        func() time.Time
}

// Authenticator parses and verifies identities and records every denial.
type Authenticator struct {
	verifier    TokenVerifier
	log         *slog.Logger
	auditor     Auditor
	tracer      trace.Tracer
	now         func() time.Time
	rejected    *prometheus.CounterVec
	unavailable prometheus.Counter
}

// NewAuthenticator builds an Authenticator and registers its metrics
// (egress_identity_rejected_total{reason}, egress_identity_verifier_unavailable_total).
func NewAuthenticator(opts Options) (*Authenticator, error) {
	a := &Authenticator{
		verifier: opts.Verifier,
		log:      opts.Logger,
		auditor:  opts.Auditor,
		tracer:   opts.Tracer,
		now:      opts.Now,
		rejected: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "egress_identity_rejected_total",
			Help: "Proxy identities rejected (request denied), by reason.",
		}, []string{"reason"}),
		unavailable: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "egress_identity_verifier_unavailable_total",
			Help: "Token verifications that failed because the verifier backend could not answer (denied; retried by the client).",
		}),
	}
	if a.verifier == nil {
		a.verifier = UnavailableVerifier{}
	}
	if a.log == nil {
		a.log = slog.New(slog.DiscardHandler)
	}
	a.log = a.log.With(slog.String("component", Component))
	if a.auditor == nil {
		a.auditor = LogAuditor{Logger: opts.Logger}
		if opts.Logger == nil {
			a.auditor = LogAuditor{Logger: slog.New(slog.DiscardHandler)}
		}
	}
	if a.tracer == nil {
		a.tracer = noop.NewTracerProvider().Tracer("identity")
	}
	if a.now == nil {
		a.now = time.Now
	}
	for _, r := range AllReasons {
		a.rejected.WithLabelValues(string(r))
	}
	if opts.Registerer != nil {
		if err := opts.Registerer.Register(a.rejected); err != nil {
			return nil, err
		}
		if err := opts.Registerer.Register(a.unavailable); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// Authenticate parses user/pass, verifies the token and checks that the token's
// run/session/test case match the username. On success the returned identity has
// RunID and SessionID set from the claims. On failure it returns a *Error wrapping
// one of the sentinel kinds; the caller must deny without contacting any upstream.
func (a *Authenticator) Authenticate(ctx context.Context, user, pass string) (RequestIdentity, TokenClaims, error) {
	ctx, span := a.tracer.Start(ctx, "identity.parse")
	defer span.End()

	id, err := parse(user, pass)
	if err != nil {
		return a.deny(ctx, id, pass, err)
	}
	claims, err := a.verify(ctx, id)
	if err != nil {
		return a.deny(ctx, id, pass, err)
	}
	id.RunID, id.SessionID = claims.RunID, claims.SessionID
	span.SetAttributes(attribute.String("run_id", id.RunID.String()), attribute.String("session_id", id.SessionID.String()))
	a.log.LogAttrs(ctx, slog.LevelDebug, "identity accepted",
		slog.String("run_id", id.RunID.String()),
		slog.String("session_id", id.SessionID.String()),
		slog.String("token_sha256_prefix", TokenFingerprint(id.Token)),
	)
	return id, claims, nil
}

func (a *Authenticator) verify(ctx context.Context, id RequestIdentity) (TokenClaims, error) {
	claims, err := a.verifier.Verify(ctx, id)
	if err != nil {
		switch {
		case errors.Is(err, ErrTokenRevoked):
			return TokenClaims{}, reject(ErrTokenRevoked, ReasonTokenRevoked)
		case errors.Is(err, ErrTokenExpired):
			return TokenClaims{}, reject(ErrTokenExpired, ReasonTokenExpired)
		case errors.Is(err, ErrTokenInvalid):
			return TokenClaims{}, reject(ErrTokenInvalid, ReasonOf(err))
		default:
			// Backend unreachable or any unexpected answer: fail closed.
			a.unavailable.Inc()
			return TokenClaims{}, reject(ErrTokenInvalid, ReasonVerifierUnavailable)
		}
	}
	// Re-check the binding deterministically; never trust the verifier alone.
	switch {
	case claims.RunID == uuid.Nil || claims.SessionID == uuid.Nil || claims.ExpiresAt.IsZero():
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonClaimsIncomplete)
	case !claims.ExpiresAt.After(a.now()):
		return TokenClaims{}, reject(ErrTokenExpired, ReasonTokenExpired)
	case id.RunID != uuid.Nil && id.RunID != claims.RunID:
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonRunMismatch)
	case id.SessionID != uuid.Nil && id.SessionID != claims.SessionID:
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonSessionMismatch)
	case claims.TestCaseID != uuid.Nil && claims.TestCaseID != id.TestCaseID:
		return TokenClaims{}, reject(ErrTokenInvalid, ReasonTestCaseMismatch)
	}
	return claims, nil
}

func (a *Authenticator) deny(ctx context.Context, id RequestIdentity, pass string, err error) (RequestIdentity, TokenClaims, error) {
	span := trace.SpanFromContext(ctx)
	reason := ReasonOf(err)
	a.rejected.WithLabelValues(string(reason)).Inc()
	ev := RejectionEvent{
		Type:              AuditEventIdentityRejected,
		Reason:            reason,
		RunID:             uuidOrEmpty(id.RunID),
		SessionID:         uuidOrEmpty(id.SessionID),
		TestCaseID:        uuidOrEmpty(id.TestCaseID),
		TokenSHA256Prefix: TokenFingerprint(pass),
	}
	span.SetStatus(codes.Error, string(reason))
	span.SetAttributes(attribute.String("reason", string(reason)))
	a.log.LogAttrs(ctx, slog.LevelWarn, "identity rejected",
		slog.String("reason", string(reason)),
		slog.String("run_id", ev.RunID),
		slog.String("session_id", ev.SessionID),
		slog.String("token_sha256_prefix", ev.TokenSHA256Prefix),
	)
	if aerr := a.auditor.IdentityRejected(ctx, ev); aerr != nil {
		// The request is denied regardless; the audit failure itself is logged.
		a.log.LogAttrs(ctx, slog.LevelError, "identity rejection audit failed", slog.String("reason", string(reason)))
	}
	return RequestIdentity{}, TokenClaims{}, err
}

func uuidOrEmpty(u uuid.UUID) string {
	if u == uuid.Nil {
		return ""
	}
	return u.String()
}
