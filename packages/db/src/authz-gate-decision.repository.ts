// Gate decision persistence (AUTHZ, CONTEXT_PACK §7, §8.4, §8.6, §8.8). The decision logic and its separation-of-duties
// checks live in `@blackwing/domain` (`recordGateDecision`); this class binds that write path to one `withTenant`
// transaction, so RLS confines the row, a missing tenant context fails closed, and the audit event is appended inside
// the same transaction: a decision that cannot be audited is not recorded.

import {
  type GateDecisionAuditEvent,
  type GateDecisionPorts,
  type GateDecisionRow,
  recordGateDecision,
} from '@blackwing/domain';
import { ConflictError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { toTenantIsolationError } from './rls.js';
import { authzGateDecisions } from './schema/authz-gate-decisions.js';
import { currentTenantId } from './tenant-context.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { GateDecisionInput } from '@blackwing/contracts';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

export interface AuthzGateDecisionRepositoryOptions {
  readonly db: Database;
  /** The ambient tenant (defaults to the request-scoped tenant). Missing or empty fails closed. */
  readonly tenant?: () => string | undefined;
  /** Appends `authz.gate.decision` inside the decision's transaction (`AuditEmitter.emitAuditInTx`). */
  readonly audit: (event: GateDecisionAuditEvent, tx: TenantTx) => Promise<void>;
  readonly metrics?: GateDecisionPorts['metrics'];
  readonly logger?: GateDecisionPorts['logger'];
}

export class AuthzGateDecisionRepository {
  constructor(private readonly options: AuthzGateDecisionRepositoryOptions) {}

  /** Records one decision in the tenant's transaction. Refusals (SoD, validation) write nothing. */
  async record(input: GateDecisionInput): Promise<GateDecisionRow> {
    const tenantId = this.tenantId();
    try {
      return await withTenant(this.options.db, tenantId, (tx) =>
        recordGateDecision(
          {
            insert: async (row) => {
              await tx.insert(authzGateDecisions).values({ ...row, tenantId });
            },
            audit: (event) => this.options.audit(event, tx),
            ...(this.options.metrics ? { metrics: this.options.metrics } : {}),
            ...(this.options.logger ? { logger: this.options.logger } : {}),
          },
          input,
        ),
      );
    } catch (error) {
      throw translate(error);
    }
  }

  private tenantId(): string {
    const tenantId = (this.options.tenant ?? currentTenantId)();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError('no tenant context: refusing to record a gate decision');
    }
    return tenantId;
  }
}

/** A second `approved` row for the same gate and subject is a conflict; a CHECK violation is a validation error. */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConflictError('gate subject already has an approved decision', { cause: error });
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid gate decision', {
      detail: 'A database check rejected the gate decision.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
