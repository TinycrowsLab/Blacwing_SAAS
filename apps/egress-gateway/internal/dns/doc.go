// Package dns will serve the sandbox-facing scoped DNS resolver built on
// github.com/miekg/dns (CONTEXT_PACK §5).
//
// It is an empty skeleton (FOUND-013); the resolver arrives with the EGRESS epic.
// Contract for that work: answers that point at out-of-scope destinations are
// blocked, each name is resolved once and its IP pinned and re-checked
// (anti-rebinding), and private/link-local/metadata ranges are refused unless
// explicitly in scope (CONTEXT_PACK §8.2).
package dns
