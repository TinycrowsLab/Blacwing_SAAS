// The drizzle-to-AuditSqlTx adapter lives in @blackwing/db so every app that appends to the ledger
// shares one implementation. Re-exported here for the outbox modules that import it locally.
export { toAuditSqlTx } from '@blackwing/db';
