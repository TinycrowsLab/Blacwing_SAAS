// Package proxy will hold the gateway's SOCKS5 TCP proxy built on
// github.com/things-go/go-socks5 (CONTEXT_PACK §5). The HTTP/1.1 forward proxy lives
// in internal/httpproxy.
//
// It is an empty skeleton (FOUND-013); the listener arrives with the EGRESS epic.
// Contract for that work: no listener may bind or forward a byte before a verified
// policy snapshot is loaded, and every connection whose policy decision cannot be
// made is denied (fail closed, CONTEXT_PACK §8.1/§8.2).
package proxy
