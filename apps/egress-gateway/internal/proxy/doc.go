// Package proxy will hold the gateway's data-plane listeners: the HTTP/1.1 and
// HTTPS (per-run CA, MITM) forward proxy built on github.com/elazarl/goproxy and the
// SOCKS5 TCP proxy built on github.com/things-go/go-socks5 (CONTEXT_PACK §5).
//
// It is an empty skeleton (FOUND-013); the listeners arrive with the EGRESS epic.
// Contract for that work: no listener may bind or forward a byte before a verified
// policy snapshot is loaded, and every connection whose policy decision cannot be
// made is denied (fail closed, CONTEXT_PACK §8.1/§8.2).
package proxy
