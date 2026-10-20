// Package policy will evaluate every egress decision against the run's signed policy
// snapshot using github.com/cedar-policy/cedar-go, mirroring the TypeScript Cedar
// evaluation with shared schema and test vectors (CONTEXT_PACK §5).
//
// It is an empty skeleton (FOUND-013); evaluation arrives with the EGRESS and POLICY
// epics. Contract for that work: the envelope is re-verified on load and on every
// refresh, expiry blocks immediately, and any evaluation error is a deny (fail
// closed, CONTEXT_PACK §8.1/§8.2/§8.11).
package policy
