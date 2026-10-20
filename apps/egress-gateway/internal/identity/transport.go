package identity

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
)

// ProxyAuthorizationHeader is the HTTP request header carrying proxy credentials.
const ProxyAuthorizationHeader = "Proxy-Authorization"

// ProxyAuthenticateValue is sent with every 407 response.
const ProxyAuthenticateValue = `Basic realm="blackwing-egress", charset="UTF-8"`

// maxHeaderLen bounds the encoded header: "Basic " + base64(user ":" pass).
const maxHeaderLen = len("Basic ") + (2*MaxFieldLen+1+2)/3*4

// SOCKS5 username/password sub-negotiation status codes (RFC 1929 §2).
const (
	SOCKSAuthSuccess byte = 0x00
	SOCKSAuthFailure byte = 0x01
)

// ParseProxyAuthorization decodes a "Basic" Proxy-Authorization header value once
// and returns the username and password for Parse. The username is everything
// before the first colon (RFC 7617). Any other scheme or a malformed value is
// ErrIdentityMalformed.
func ParseProxyAuthorization(header string) (user, pass string, err error) {
	if strings.TrimSpace(header) == "" {
		return "", "", reject(ErrIdentityMalformed, ReasonMissingCredentials)
	}
	if len(header) > maxHeaderLen {
		return "", "", reject(ErrIdentityMalformed, ReasonTooLong)
	}
	scheme, encoded, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") || encoded == "" || strings.ContainsAny(encoded, " \t") {
		return "", "", reject(ErrIdentityMalformed, ReasonMalformedHeader)
	}
	raw, derr := base64.StdEncoding.Strict().DecodeString(encoded)
	if derr != nil {
		return "", "", reject(ErrIdentityMalformed, ReasonMalformedHeader)
	}
	user, pass, ok = strings.Cut(string(raw), ":")
	if !ok {
		return "", "", reject(ErrIdentityMalformed, ReasonMalformedHeader)
	}
	return user, pass, nil
}

// HTTPStatus maps an authentication result to the HTTP status the proxy returns:
// 0 for success (continue), 407 Proxy Authentication Required for every error.
func HTTPStatus(err error) int {
	if err == nil {
		return 0
	}
	return http.StatusProxyAuthRequired
}

// SOCKSStatus maps an authentication result to the RFC 1929 status byte. Every
// error is an auth failure, after which the SOCKS server must close the connection.
func SOCKSStatus(err error) byte {
	if err == nil {
		return SOCKSAuthSuccess
	}
	return SOCKSAuthFailure
}

// AuthenticateHTTP authenticates the Proxy-Authorization header of r.
func (a *Authenticator) AuthenticateHTTP(r *http.Request) (RequestIdentity, TokenClaims, error) {
	values := r.Header.Values(ProxyAuthorizationHeader)
	if len(values) > 1 {
		return a.denyHeader(r.Context(), reject(ErrIdentityMalformed, ReasonMalformedHeader))
	}
	user, pass, err := ParseProxyAuthorization(r.Header.Get(ProxyAuthorizationHeader))
	if err != nil {
		return a.denyHeader(r.Context(), err)
	}
	return a.Authenticate(r.Context(), user, pass)
}

func (a *Authenticator) denyHeader(ctx context.Context, err error) (RequestIdentity, TokenClaims, error) {
	ctx, span := a.tracer.Start(ctx, "identity.parse")
	defer span.End()
	return a.deny(ctx, RequestIdentity{}, "", err)
}

// AuthenticateSOCKS authenticates RFC 1929 credentials and returns the status
// byte to send alongside the result.
func (a *Authenticator) AuthenticateSOCKS(ctx context.Context, user, pass string) (RequestIdentity, TokenClaims, byte, error) {
	id, claims, err := a.Authenticate(ctx, user, pass)
	return id, claims, SOCKSStatus(err), err
}

type ctxKey struct{}

// Verified is a successfully authenticated identity with its token claims.
type Verified struct {
	Identity RequestIdentity
	Claims   TokenClaims
}

// FromContext returns the identity stored by Middleware.
func FromContext(ctx context.Context) (Verified, bool) {
	v, ok := ctx.Value(ctxKey{}).(Verified)
	return v, ok
}

// Middleware authenticates every request before next runs. On failure it answers
// 407 with Proxy-Authenticate and closes the connection; next is never called, so
// no upstream connection is attempted. On success it removes the
// Proxy-Authorization header (the token must never reach the target) and stores
// the identity in the request context.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, claims, err := a.AuthenticateHTTP(r)
		if err != nil {
			WriteProxyAuthRequired(w)
			return
		}
		r.Header.Del(ProxyAuthorizationHeader)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, Verified{Identity: id, Claims: claims})))
	})
}

// WriteProxyAuthRequired writes the fail-closed 407 response.
func WriteProxyAuthRequired(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Proxy-Authenticate", ProxyAuthenticateValue)
	h.Set("Connection", "close")
	h.Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusProxyAuthRequired)
	_, _ = w.Write([]byte("proxy authentication required\n"))
}
