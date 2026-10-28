import type { AuditEventInput } from '@blackwing/audit';

/**
 * The ports the persona override service composes (REGISTRY-010). The Postgres store and the audit writer
 * are supplied by the composition root; the service never reaches past these interfaces.
 *
 * `Tx` is the transaction type of the store. A change and its audit event commit together: `replace` runs
 * `afterWrite` in the same transaction, and a rejection there rolls the change back (§8.8).
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface PersonaPrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id); the `actor` recorded on the audit event. */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  readonly tokenId?: string;
}

/** The four whitelisted columns as the store holds them: NULL means "use the persona's base value". */
export interface PersonaOverrideColumns {
  readonly effort: string | null;
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
  readonly lowerStandardTier: boolean | null;
}

/** A stored override row. */
export interface StoredPersonaOverride extends PersonaOverrideColumns {
  readonly persona: string;
  readonly updatedAt: Date;
}

export interface PersonaOverrideStore<Tx> {
  find(tenantId: string, persona: string): Promise<StoredPersonaOverride | null>;
  replace(
    tenantId: string,
    persona: string,
    columns: PersonaOverrideColumns,
    afterWrite: (tx: Tx) => Promise<void>,
  ): Promise<StoredPersonaOverride>;
}

/** Appends an audit event inside the transaction `tx` (`AuditEmitter.emitAuditInTx`). */
export type PersonaAuditWriter<Tx> = (tx: Tx, event: AuditEventInput) => Promise<void>;

/** Structured-warning sink, compatible with `@blackwing/logger`. */
export interface PersonaWarnSink {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}
