// Package capture will record request/response evidence for every proxied exchange
// and hand it to the evidence pipeline (CONTEXT_PACK §7 evidence_items).
//
// It is an empty skeleton (FOUND-013); capture arrives with the EGRESS epic.
// Contract for that work: if capture cannot be written, the exchange is blocked
// (fail closed, CONTEXT_PACK §8.2), and injected credentials or other secrets are
// never written to capture or logs in plaintext (CONTEXT_PACK §8.7).
package capture
