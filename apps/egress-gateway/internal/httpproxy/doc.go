// Package httpproxy is the gateway's HTTP/1.1 forward-proxy data plane, built on
// github.com/elazarl/goproxy (CONTEXT_PACK §5). It authenticates the proxy identity
// of every request (internal/identity), asks an Authorizer for the scope and Cedar
// decision, and only then forwards plain-HTTP requests or sets up CONNECT tunnels.
// Everything not explicitly allowed is denied (§8.2).
//
// Request flow, in order, each step failing closed before any upstream socket exists:
//
//  1. gateway not ready -> 503
//  2. missing/invalid Proxy-Authorization -> 407 (before the body is read)
//  3. Upgrade (h2c, websocket), unknown method, non-http scheme, CONNECT to a
//     port outside Options.ConnectPorts -> 400/403
//  4. Authorizer.Authorize (scope match + policy) -> 403 problem body on deny
//  5. BudgetGuard, hop-by-hop stripping, SessionInjector, upstream round trip
//  6. Capturer.OnPair on the response; a capture failure blocks the response (§8.2)
//
// v1 is HTTP/1.1 only: the listener is plain TCP with HTTP/2 disabled, HTTP/2 prior
// knowledge is refused by net/http, and every Upgrade request is denied so no
// traffic can leave the capture and budget hooks. An oversized header block is
// answered by net/http with 431 (a 4xx, connection closed), and a malformed request
// line with 400, both before any handler runs.
//
// Upstream connections are never reused: the shared transport has keep-alive off,
// so a connection (and any credential injected on it) can never serve a second
// identity (§8.6).
package httpproxy
