// Production `Gate2ExceptionStore` over the tenant-scoped `gate2_exceptions` table (GATE2-001, #207). Each event runs
// in one `withTenant` transaction through the Gate 2 service in `@blackwing/db`, which holds the state machine, the
// `gate_decisions` row and the audit event. A rule refusal is returned as a value; anything else (a lost database)
// is thrown so the activity is retried.

import { createAuditEmitter, gate2AuditInput } from '@blackwing/audit';
import {
  type Database,
  gate2DatabaseNow,
  gate2Service,
  pendingGate2ExceptionIds,
  toAuditSqlTx,
  type TenantTx,
  withTenant,
} from '@blackwing/db';

import { refusalOf } from './gate2-exception.js';

import type { Gate2ExceptionStore } from './ports.js';
import type { Gate2ExceptionVerdict } from './types.js';

/** The Postgres store the execution workflow's Gate 2 exception activities use. */
export function createPgGate2ExceptionStore(db: Database): Gate2ExceptionStore {
  const emitter = createAuditEmitter();
  const serviceFor = (tx: TenantTx) =>
    gate2Service(tx, {
      audit: async (inTx, event) => {
        await emitter.emitAuditInTx(toAuditSqlTx(inTx), gate2AuditInput(event));
      },
    });

  return {
    read(tenantId, runId, exceptionId) {
      return withTenant(db, tenantId, async (tx) => {
        const exception = await serviceFor(tx).get(exceptionId);
        if (exception?.runId !== runId) return null;
        return {
          state: exception.state,
          timeoutAt: exception.timeoutAt,
          now: (await gate2DatabaseNow(tx)).toISOString(),
        };
      });
    },

    apply(tenantId, runId, exceptionId, change): Promise<Gate2ExceptionVerdict> {
      return withTenant(db, tenantId, async (tx): Promise<Gate2ExceptionVerdict> => {
        const exception = await serviceFor(tx).get(exceptionId);
        if (exception?.runId !== runId) {
          return { kind: 'refused', code: 'GATE2_NOT_FOUND' };
        }
        try {
          const result = await serviceFor(tx).decide({
            exceptionId,
            event: change.event,
            actor: change.actor,
            ...(change.reason === undefined ? {} : { reason: change.reason }),
          });
          return result.applied
            ? { kind: 'applied', state: result.exception.state }
            : { kind: 'lost', state: result.exception.state };
        } catch (error) {
          const code = refusalOf(error);
          if (code === undefined) throw error;
          return { kind: 'refused', code };
        }
      });
    },

    pendingIds(tenantId, runId) {
      return withTenant(db, tenantId, (tx) => pendingGate2ExceptionIds(tx, runId));
    },
  };
}
