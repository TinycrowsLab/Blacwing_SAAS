// The ledger adapter for tenant policy changes (POLICY-001, CONTEXT_PACK §8.8). The repository hands each
// mutation to an audit hook inside its own transaction; this module turns those events into ledger inputs and
// appends them with the audit emitter, in that same transaction, so a change that cannot be audited is not made.
// Metadata carries version numbers and digests only, never the policy text.

import { createAuditEmitter, type AuditEmitter, type AuditEventInput } from '@blackwing/audit';
import {
  toAuditSqlTx,
  type TenantPolicyAuditEvent,
  type TenantPolicyAuditHook,
} from '@blackwing/db';

/** The ledger input for one tenant policy event. The target is the tenant; the catalogue sets the severity. */
export function tenantPolicyAuditInput(event: TenantPolicyAuditEvent): AuditEventInput {
  const base = {
    tenantId: event.tenantId,
    actor: { type: 'user', id: event.actorId },
    target: { type: 'tenant', id: event.tenantId },
    outcome: 'success',
  } as const;
  switch (event.action) {
    case 'policy.version.created':
      return {
        ...base,
        action: event.action,
        metadata: { version: event.version, sha256: event.sha256 },
      };
    case 'policy.activated':
      return {
        ...base,
        action: event.action,
        metadata: { version: event.version, previousVersion: event.previousVersion },
      };
    case 'policy.rolled_back':
      return {
        ...base,
        action: event.action,
        metadata: { toVersion: event.toVersion, previousVersion: event.previousVersion },
      };
  }
}

/** The audit hook of `TenantPolicyRepository`: appends the event on the mutation's own transaction. */
export function createTenantPolicyAuditHook(
  emitter: Pick<AuditEmitter, 'emitAuditInTx'> = createAuditEmitter(),
): TenantPolicyAuditHook {
  return async (event, tx) => {
    await emitter.emitAuditInTx(toAuditSqlTx(tx), tenantPolicyAuditInput(event));
  };
}
