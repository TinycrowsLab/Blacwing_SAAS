import type {
  PersonaOverrideColumns,
  PersonaOverrideStore,
  StoredPersonaOverride,
} from './ports.js';
import type { AuditEventInput } from '@blackwing/audit';

/** The in-memory transaction handle: staged writes commit only when `afterWrite` resolves. */
export interface MemoryPersonaTx {
  readonly tenantId: string;
}

/** An in-memory override store for unit tests and the offline API. Tenant-keyed, never cross-tenant. */
export interface InMemoryPersonaOverrideStore extends PersonaOverrideStore<MemoryPersonaTx> {
  /** Rows currently committed, for assertions. */
  committed(): readonly { readonly tenantId: string; readonly row: StoredPersonaOverride }[];
}

export function createInMemoryPersonaOverrideStore(
  now: () => Date = () => new Date(),
): InMemoryPersonaOverrideStore {
  const rows = new Map<string, { tenantId: string; row: StoredPersonaOverride }>();
  const keyOf = (tenantId: string, persona: string): string => `${tenantId}\u0000${persona}`;

  return {
    find(tenantId, persona) {
      return Promise.resolve(rows.get(keyOf(tenantId, persona))?.row ?? null);
    },

    async replace(tenantId, persona, columns: PersonaOverrideColumns, afterWrite) {
      const row: StoredPersonaOverride = { ...columns, persona, updatedAt: now() };
      // Staged: the row is visible only after the audit write in the same "transaction" succeeded.
      await afterWrite({ tenantId });
      rows.set(keyOf(tenantId, persona), { tenantId, row });
      return row;
    },

    committed() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
  };
}

/** Records audit events written through the in-memory transaction. */
export class RecordingPersonaAudit {
  readonly events: AuditEventInput[] = [];

  write(_tx: MemoryPersonaTx, event: AuditEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
