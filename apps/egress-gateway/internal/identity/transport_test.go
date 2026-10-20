package identity_test

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway/internal/identity"
)

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestParseProxyAuthorization(t *testing.T) {
	user, pass, err := identity.ParseProxyAuthorization(basic("tc_x", "a:b:c"))
	require.NoError(t, err)
	assert.Equal(t, "tc_x", user)
	assert.Equal(t, "a:b:c", pass, "password may contain colons; username ends at the first")

	_, _, err = identity.ParseProxyAuthorization("basic " + base64.StdEncoding.EncodeToString([]byte("u:p")))
	require.NoError(t, err, "scheme is case-insensitive")

	for name, h := range map[string]string{
		"empty":           "",
		"whitespace":      "   ",
		"bearer scheme":   "Bearer abc",
		"no credentials":  "Basic",
		"bad base64":      "Basic !!!",
		"unpadded base64": "Basic " + base64.RawStdEncoding.EncodeToString([]byte("u:pw")),
		"no colon":        "Basic " + base64.StdEncoding.EncodeToString([]byte("userpass")),
		"extra field":     basic("u", "p") + " x",
		"overlong":        "Basic " + strings.Repeat("A", 4096),
	} {
		t.Run(name, func(t *testing.T) {
			_, _, err := identity.ParseProxyAuthorization(h)
			require.ErrorIs(t, err, identity.ErrIdentityMalformed)
		})
	}
}

func TestStatusMapping(t *testing.T) {
	assert.Equal(t, 0, identity.HTTPStatus(nil))
	for _, err := range []error{identity.ErrIdentityMalformed, identity.ErrTokenInvalid, identity.ErrTokenRevoked, identity.ErrTokenExpired, io.EOF} {
		assert.Equal(t, http.StatusProxyAuthRequired, identity.HTTPStatus(err))
		assert.Equal(t, identity.SOCKSAuthFailure, identity.SOCKSStatus(err))
	}
	assert.Equal(t, identity.SOCKSAuthSuccess, identity.SOCKSStatus(nil))
}

// proxyUnderTest wires the middleware in front of a handler that forwards to a
// real upstream, so the test can prove no upstream connection happens on deny.
func proxyUnderTest(t *testing.T, f *fixture) (proxy *httptest.Server, upstreamHits *atomic.Int64, sawAuth *atomic.Bool) {
	t.Helper()
	upstreamHits, sawAuth = &atomic.Int64{}, &atomic.Bool{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		if r.Header.Get(identity.ProxyAuthorizationHeader) != "" {
			sawAuth.Store(true)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)

	forward := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, ok := identity.FromContext(r.Context())
		if !ok || v.Identity.RunID != f.run {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream.URL, nil)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		req.Header = r.Header.Clone()
		resp, err := upstream.Client().Do(req)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_ = resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
	})
	proxy = httptest.NewServer(f.auth.Middleware(forward))
	t.Cleanup(proxy.Close)
	return proxy, upstreamHits, sawAuth
}

func doProxy(t *testing.T, url, auth string, extra ...string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	require.NoError(t, err)
	if auth != "" {
		req.Header.Set(identity.ProxyAuthorizationHeader, auth)
	}
	for _, v := range extra {
		req.Header.Add(identity.ProxyAuthorizationHeader, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestMiddlewareDeniesWithoutUpstream(t *testing.T) {
	f := newFixture(t, nil)
	proxy, hits, _ := proxyUnderTest(t, f)
	revokedUser := f.user()

	cases := map[string]func() string{
		"missing header":       func() string { return "" },
		"malformed identity":   func() string { return basic("tc_nope", testToken) },
		"duplicate segments":   func() string { return basic(f.user()+".tc_"+f.tc.String(), testToken) },
		"unknown token":        func() string { return basic(f.user(), "tok_unknown") },
		"wrong scheme":         func() string { return "Bearer " + testToken },
		"cross-run token":      func() string { return basic(f.user()+".run_"+v7(t).String(), testToken) },
		"whitespace-only user": func() string { return basic("   ", testToken) },
	}
	for name, auth := range cases {
		t.Run(name, func(t *testing.T) {
			resp := doProxy(t, proxy.URL, auth())
			assert.Equal(t, http.StatusProxyAuthRequired, resp.StatusCode)
			assert.Equal(t, identity.ProxyAuthenticateValue, resp.Header.Get("Proxy-Authenticate"))
			assert.Equal(t, int64(0), hits.Load(), "no upstream connection attempted")
		})
	}

	t.Run("two Proxy-Authorization headers", func(t *testing.T) {
		resp := doProxy(t, proxy.URL, basic(f.user(), testToken), basic(f.user(), testToken))
		assert.Equal(t, http.StatusProxyAuthRequired, resp.StatusCode)
		assert.Equal(t, int64(0), hits.Load())
	})

	t.Run("revoked token", func(t *testing.T) {
		f.verifier.Revoke(testToken)
		t.Cleanup(func() { f.verifier.Add(testToken, liveClaims(f)) })
		resp := doProxy(t, proxy.URL, basic(revokedUser, testToken))
		assert.Equal(t, http.StatusProxyAuthRequired, resp.StatusCode)
		assert.Equal(t, int64(0), hits.Load())
		assert.Equal(t, identity.ReasonTokenRevoked, f.auditor.events[len(f.auditor.events)-1].Reason)
	})

	assert.NotContains(t, f.logs.String(), testToken)
}

func TestMiddlewareForwardsVerifiedWithoutToken(t *testing.T) {
	f := newFixture(t, nil)
	proxy, hits, sawAuth := proxyUnderTest(t, f)
	resp := doProxy(t, proxy.URL, basic(f.user(), testToken))
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, int64(1), hits.Load())
	assert.False(t, sawAuth.Load(), "Proxy-Authorization is stripped before forwarding")
}

func TestAuthenticateSOCKS(t *testing.T) {
	f := newFixture(t, nil)
	id, _, status, err := f.auth.AuthenticateSOCKS(context.Background(), f.user(), testToken)
	require.NoError(t, err)
	assert.Equal(t, identity.SOCKSAuthSuccess, status)
	assert.Equal(t, f.run, id.RunID)

	f.verifier.Revoke(testToken)
	_, _, status, err = f.auth.AuthenticateSOCKS(context.Background(), f.user(), testToken)
	require.ErrorIs(t, err, identity.ErrTokenRevoked)
	assert.Equal(t, identity.SOCKSAuthFailure, status)
}

func liveClaims(f *fixture) identity.TokenClaims {
	return identity.TokenClaims{RunID: f.run, SessionID: f.sess, ExpiresAt: fixedNow.Add(time.Hour)}
}
