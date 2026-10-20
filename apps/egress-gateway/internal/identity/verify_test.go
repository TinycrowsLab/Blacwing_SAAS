package identity_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
)

var fixedNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

type recordingAuditor struct {
	mu     sync.Mutex
	events []identity.RejectionEvent
	err    error
}

func (r *recordingAuditor) IdentityRejected(_ context.Context, ev identity.RejectionEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	return r.err
}

type verifierFunc func(context.Context, identity.RequestIdentity) (identity.TokenClaims, error)

func (f verifierFunc) Verify(ctx context.Context, id identity.RequestIdentity) (identity.TokenClaims, error) {
	return f(ctx, id)
}

type fixture struct {
	auth     *identity.Authenticator
	verifier *identity.StaticVerifier
	auditor  *recordingAuditor
	reg      *prometheus.Registry
	logs     *bytes.Buffer
	spans    *tracetest.SpanRecorder
	run      uuid.UUID
	sess     uuid.UUID
	tc       uuid.UUID
	role     uuid.UUID
}

func newFixture(t *testing.T, v identity.TokenVerifier) *fixture {
	t.Helper()
	f := &fixture{
		verifier: &identity.StaticVerifier{Now: func() time.Time { return fixedNow }},
		auditor:  &recordingAuditor{},
		reg:      prometheus.NewRegistry(),
		logs:     &bytes.Buffer{},
		spans:    tracetest.NewSpanRecorder(),
		run:      v7(t), sess: v7(t), tc: v7(t), role: v7(t),
	}
	if v == nil {
		v = f.verifier
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(f.spans))
	auth, err := identity.NewAuthenticator(identity.Options{
		Verifier:   v,
		Logger:     slog.New(slog.NewJSONHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Auditor:    f.auditor,
		Registerer: f.reg,
		Tracer:     tp.Tracer("test"),
		Now:        func() time.Time { return fixedNow },
	})
	require.NoError(t, err)
	f.auth = auth
	f.verifier.Add(testToken, identity.TokenClaims{RunID: f.run, SessionID: f.sess, ExpiresAt: fixedNow.Add(time.Hour)})
	return f
}

func (f *fixture) user() string {
	return "tc_" + f.tc.String() + ".role_" + f.role.String()
}

func (f *fixture) rejected(reason identity.Reason) float64 {
	c, err := f.reg.Gather()
	if err != nil {
		panic(err)
	}
	for _, mf := range c {
		if mf.GetName() != "egress_identity_rejected_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			if m.GetLabel()[0].GetValue() == string(reason) {
				return m.GetCounter().GetValue()
			}
		}
	}
	return -1
}

func TestAuthenticateLiveToken(t *testing.T) {
	f := newFixture(t, nil)
	id, claims, err := f.auth.Authenticate(context.Background(), f.user(), testToken)
	require.NoError(t, err)
	assert.Equal(t, f.run, id.RunID, "run filled from claims")
	assert.Equal(t, f.sess, id.SessionID, "session filled from claims")
	assert.Equal(t, f.tc, id.TestCaseID)
	assert.Equal(t, f.run, claims.RunID)
	assert.Empty(t, f.auditor.events)
	assert.NotContains(t, f.logs.String(), testToken)

	// Explicit matching run/session segments are accepted too.
	_, _, err = f.auth.Authenticate(context.Background(), f.user()+".run_"+f.run.String()+".sess_"+f.sess.String(), testToken)
	require.NoError(t, err)

	spans := f.spans.Ended()
	require.NotEmpty(t, spans)
	assert.Equal(t, "identity.parse", spans[0].Name())
}

func TestAuthenticateRejections(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(f *fixture) (user, pass string)
		kind   error
		reason identity.Reason
	}{
		{"malformed identity", func(_ *fixture) (string, string) { return "tc_bad", testToken }, identity.ErrIdentityMalformed, identity.ReasonInvalidUUID},
		{"unknown token", func(f *fixture) (string, string) { return f.user(), "tok_unknown" }, identity.ErrTokenInvalid, identity.ReasonTokenUnknown},
		{"revoked token", func(f *fixture) (string, string) {
			f.verifier.Revoke(testToken)
			return f.user(), testToken
		}, identity.ErrTokenRevoked, identity.ReasonTokenRevoked},
		{"expired token", func(f *fixture) (string, string) {
			f.verifier.Add("tok_old", identity.TokenClaims{RunID: f.run, SessionID: f.sess, ExpiresAt: fixedNow.Add(-time.Second)})
			return f.user(), "tok_old"
		}, identity.ErrTokenExpired, identity.ReasonTokenExpired},
		{"expiry exactly at now denies", func(f *fixture) (string, string) {
			f.verifier.Add("tok_edge", identity.TokenClaims{RunID: f.run, SessionID: f.sess, ExpiresAt: fixedNow})
			return f.user(), "tok_edge"
		}, identity.ErrTokenExpired, identity.ReasonTokenExpired},
		{"cross-run token reuse", func(f *fixture) (string, string) {
			return f.user() + ".run_" + v7(t).String(), testToken
		}, identity.ErrTokenInvalid, identity.ReasonRunMismatch},
		{"cross-session token reuse", func(f *fixture) (string, string) {
			return f.user() + ".sess_" + v7(t).String(), testToken
		}, identity.ErrTokenInvalid, identity.ReasonSessionMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, nil)
			user, pass := c.setup(f)
			id, _, err := f.auth.Authenticate(context.Background(), user, pass)
			require.Error(t, err)
			assert.ErrorIs(t, err, c.kind)
			assert.Equal(t, c.reason, identity.ReasonOf(err))
			assert.Equal(t, identity.RequestIdentity{}, id)
			assert.InDelta(t, 1.0, f.rejected(c.reason), 0)

			require.Len(t, f.auditor.events, 1)
			ev := f.auditor.events[0]
			assert.Equal(t, identity.AuditEventIdentityRejected, ev.Type)
			assert.Equal(t, c.reason, ev.Reason)
			assert.Equal(t, identity.TokenFingerprint(pass), ev.TokenSHA256Prefix)

			out := f.logs.String()
			assert.NotContains(t, out, pass, "token value never logged")
			assert.Contains(t, out, `"token_sha256_prefix":"`+identity.TokenFingerprint(pass)+`"`)
			assert.Contains(t, out, `"component":"identity"`)
			assert.Contains(t, out, `"reason":"`+string(c.reason)+`"`)
		})
	}
}

func TestRejectionAuditCarriesParsedRunAndSession(t *testing.T) {
	f := newFixture(t, nil)
	otherRun := v7(t)
	_, _, err := f.auth.Authenticate(context.Background(), f.user()+".sess_"+f.sess.String()+".run_"+otherRun.String(), testToken)
	require.ErrorIs(t, err, identity.ErrTokenInvalid)
	require.Len(t, f.auditor.events, 1)
	assert.Equal(t, otherRun.String(), f.auditor.events[0].RunID)
	assert.Equal(t, f.sess.String(), f.auditor.events[0].SessionID)
	assert.Contains(t, f.logs.String(), `"run_id":"`+otherRun.String()+`"`)
}

// A verifier that wrongly accepts must still be caught by the deterministic re-check.
func TestAuthenticateRechecksVerifierClaims(t *testing.T) {
	run, sess, tc := v7(t), v7(t), v7(t)
	cases := []struct {
		name   string
		user   string
		claims identity.TokenClaims
		kind   error
		reason identity.Reason
	}{
		{"run mismatch", "tc_" + tc.String() + ".run_" + v7(t).String(),
			identity.TokenClaims{RunID: run, SessionID: sess, ExpiresAt: fixedNow.Add(time.Hour)}, identity.ErrTokenInvalid, identity.ReasonRunMismatch},
		{"session mismatch", "tc_" + tc.String() + ".sess_" + v7(t).String(),
			identity.TokenClaims{RunID: run, SessionID: sess, ExpiresAt: fixedNow.Add(time.Hour)}, identity.ErrTokenInvalid, identity.ReasonSessionMismatch},
		{"test case mismatch", "tc_" + v7(t).String(),
			identity.TokenClaims{RunID: run, SessionID: sess, TestCaseID: tc, ExpiresAt: fixedNow.Add(time.Hour)}, identity.ErrTokenInvalid, identity.ReasonTestCaseMismatch},
		{"expired at boundary", "tc_" + tc.String(),
			identity.TokenClaims{RunID: run, SessionID: sess, ExpiresAt: fixedNow}, identity.ErrTokenExpired, identity.ReasonTokenExpired},
		{"claims missing run", "tc_" + tc.String(),
			identity.TokenClaims{SessionID: sess, ExpiresAt: fixedNow.Add(time.Hour)}, identity.ErrTokenInvalid, identity.ReasonClaimsIncomplete},
		{"claims missing expiry", "tc_" + tc.String(),
			identity.TokenClaims{RunID: run, SessionID: sess}, identity.ErrTokenInvalid, identity.ReasonClaimsIncomplete},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, verifierFunc(func(context.Context, identity.RequestIdentity) (identity.TokenClaims, error) {
				return c.claims, nil
			}))
			_, _, err := f.auth.Authenticate(context.Background(), c.user, testToken)
			assert.ErrorIs(t, err, c.kind)
			assert.Equal(t, c.reason, identity.ReasonOf(err))
		})
	}

	t.Run("matching test case accepted", func(t *testing.T) {
		f := newFixture(t, verifierFunc(func(context.Context, identity.RequestIdentity) (identity.TokenClaims, error) {
			return identity.TokenClaims{RunID: run, SessionID: sess, TestCaseID: tc, ExpiresAt: fixedNow.Add(time.Hour)}, nil
		}))
		_, _, err := f.auth.Authenticate(context.Background(), "tc_"+tc.String(), testToken)
		require.NoError(t, err)
	})
}

func TestVerifierUnreachableFailsClosed(t *testing.T) {
	f := newFixture(t, verifierFunc(func(context.Context, identity.RequestIdentity) (identity.TokenClaims, error) {
		return identity.TokenClaims{}, errors.New("dial tcp 127.0.0.1:16379: connect: connection refused")
	}))
	_, _, err := f.auth.Authenticate(context.Background(), f.user(), testToken)
	require.ErrorIs(t, err, identity.ErrTokenInvalid)
	assert.Equal(t, identity.ReasonVerifierUnavailable, identity.ReasonOf(err))
	assert.InDelta(t, 1.0, f.rejected(identity.ReasonVerifierUnavailable), 0)
	mfs, gerr := f.reg.Gather()
	require.NoError(t, gerr)
	var retry float64 = -1
	for _, mf := range mfs {
		if mf.GetName() == "egress_identity_verifier_unavailable_total" {
			retry = mf.GetMetric()[0].GetCounter().GetValue()
		}
	}
	assert.InDelta(t, 1.0, retry, 0)
	assert.NotContains(t, err.Error(), "127.0.0.1", "backend detail not exposed to the sandbox")
}

func TestDefaultsFailClosed(t *testing.T) {
	auth, err := identity.NewAuthenticator(identity.Options{})
	require.NoError(t, err)
	_, _, err = auth.Authenticate(context.Background(), "tc_"+v7(t).String(), testToken)
	require.ErrorIs(t, err, identity.ErrTokenInvalid)
	assert.Equal(t, identity.ReasonVerifierUnavailable, identity.ReasonOf(err))
}

func TestAuditFailureStillDenies(t *testing.T) {
	f := newFixture(t, nil)
	f.auditor.err = errors.New("ledger down")
	_, _, err := f.auth.Authenticate(context.Background(), f.user(), "tok_unknown")
	require.ErrorIs(t, err, identity.ErrTokenInvalid)
	assert.Contains(t, f.logs.String(), "identity rejection audit failed")
}

func TestMetricsPreinitialisedAndRegisterOnce(t *testing.T) {
	f := newFixture(t, nil)
	assert.Equal(t, len(identity.AllReasons), testutil.CollectAndCount(f.reg, "egress_identity_rejected_total"))
	_, err := identity.NewAuthenticator(identity.Options{Registerer: f.reg})
	require.Error(t, err, "duplicate registration is reported")
}

func TestLogAuditorWritesEvent(t *testing.T) {
	var buf bytes.Buffer
	a := identity.LogAuditor{Logger: slog.New(slog.NewJSONHandler(&buf, nil))}
	require.NoError(t, a.IdentityRejected(context.Background(), identity.RejectionEvent{
		Type: identity.AuditEventIdentityRejected, Reason: identity.ReasonTokenRevoked, TokenSHA256Prefix: "abc",
	}))
	assert.Contains(t, buf.String(), `"event":"egress.identity_rejected"`)
	assert.Contains(t, buf.String(), `"component":"audit"`)
}

func TestStaticVerifierRevokeUnknownIsNoop(t *testing.T) {
	v := &identity.StaticVerifier{}
	v.Revoke("nope")
	_, err := v.Verify(context.Background(), identity.RequestIdentity{Token: "nope"})
	assert.ErrorIs(t, err, identity.ErrTokenInvalid)
}
