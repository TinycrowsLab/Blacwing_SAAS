// DEMO-STORY audit ledger rules: the SHA-256 hash chain over demo.audit_events lives in @blackwing/audit
// (demo-chain.ts), shared with the hunt engine that writes `gate2.expired`. Re-exported here under the old names.
export {
  DEMO_GENESIS as GENESIS,
  demoAuditHash as auditHash,
  verifyDemoChain as verifyChain,
  type DemoAuditPayload as AuditPayload,
  type DemoAuditFields as AuditFields,
  type DemoAuditRef as AuditRef,
  type DemoChainState as ChainState,
} from '@blackwing/audit';
