// Tenant policy version persistence (POLICY-001, CONTEXT_PACK §7, §8.6, §8.8, §8.11). Versions are
// append-only: `createVersion` always inserts a new row and never updates a stored one; the database trigger
// refuses any change except the `active` pointer. Activation and rollback move that pointer inside one
// transaction, under a per-tenant advisory lock, so concurrent writers serialise and exactly one wins; the
// partial unique index is the last line of defence. Every method runs through `withTenant`, so RLS confines
// it and a missing tenant context fails closed. Each mutation writes its audit event in the same transaction.

import { createHash } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import { AppError, NotFoundError } from '@blackwing/errors';

import { ConcurrencyError } from './repository.js';
import { tenantPolicies, type TenantPolicyRow } from './schema/tenant-policies.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';

/** One stored policy version. `ruleBuilderJson` is present when the version came from the rule builder. */
export interface PolicyVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly cedarSource: string;
  readonly ruleBuilderJson: Readonly<Record<string, unknown>> | null;
  readonly sha256: string;
  readonly author: string;
  readonly active: boolean;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** A version without its source text: what the history listing returns. */
export type PolicyVersionSummary = Omit<PolicyVersion, 'cedarSource' | 'ruleBuilderJson'>;

/** What to write for a new version. `sha256` is over the canonical `cedarSource` (computed by the caller). */
export interface NewPolicyVersion {
  readonly tenantId: string;
  readonly cedarSource: string;
  readonly sha256: string;
  readonly ruleBuilderJson?: Readonly<Record<string, unknown>> | null;
  readonly note?: string | null;
  readonly actorId: string;
}

/** The audit events of this module. Metadata carries ids, versions and digests only, never the source. */
export type TenantPolicyAuditEvent =
  | {
      readonly action: 'policy.version.created';
      readonly tenantId: string;
      readonly actorId: string;
      readonly version: number;
      readonly sha256: string;
    }
  | {
      readonly action: 'policy.activated';
      readonly tenantId: string;
      readonly actorId: string;
      readonly version: number;
      readonly previousVersion: number | null;
    }
  | {
      readonly action: 'policy.rolled_back';
      readonly tenantId: string;
      readonly actorId: string;
      readonly toVersion: number;
      readonly previousVersion: number | null;
    };

/** Audit hook (§8.8): runs inside the mutation's transaction; a throw rolls the change back. */
export type TenantPolicyAuditHook = (
  event: TenantPolicyAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface TenantPolicyRepositoryOptions {
  readonly db: Database;
  readonly audit: TenantPolicyAuditHook;
}

/** Result of an activation or rollback. `changed` is false when the target was already active. */
export interface ActivationResult {
  readonly record: PolicyVersion;
  readonly previousVersion: number | null;
  readonly changed: boolean;
}

/** `POLICY_VERSION_NOT_FOUND`: the version does not exist in this tenant (404). */
export class PolicyVersionNotFoundError extends AppError {
  declare readonly code: 'POLICY_VERSION_NOT_FOUND';
  constructor(version: number) {
    super('POLICY_VERSION_NOT_FOUND', `policy version ${String(version)} not found`, {
      detail: 'The policy version does not exist in this tenant.',
    });
    this.name = 'PolicyVersionNotFoundError';
  }
}

/** The source of the first version of every tenant: the empty tenant policy (baseline only). */
const EMPTY_SOURCE_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');

const toPolicyVersion = (row: TenantPolicyRow): PolicyVersion => ({
  id: row.id,
  tenantId: row.tenantId,
  version: row.version,
  cedarSource: row.cedarSource,
  ruleBuilderJson: row.ruleBuilderJson ?? null,
  sha256: row.sha256,
  author: row.author,
  active: row.active,
  note: row.note,
  createdAt: row.createdAt,
});

const toSummary = (row: TenantPolicyRow): PolicyVersionSummary => ({
  id: row.id,
  tenantId: row.tenantId,
  version: row.version,
  sha256: row.sha256,
  author: row.author,
  active: row.active,
  note: row.note,
  createdAt: row.createdAt,
});

/** Serialises every write to one tenant's policy versions (creation, activation, rollback). */
async function lockTenantPolicies(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}::text, 0))`);
}

/** Tenant-scoped persistence of policy versions and the active pointer. */
export class TenantPolicyRepository {
  private readonly options: TenantPolicyRepositoryOptions;

  constructor(options: TenantPolicyRepositoryOptions) {
    this.options = options;
  }

  /** The tenant's active version, or `undefined` when none is active (baseline only). */
  async getActive(tenantId: string): Promise<PolicyVersion | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantPolicies)
        .where(and(eq(tenantPolicies.tenantId, tenantId), eq(tenantPolicies.active, true)))
        .limit(1);
      return rows[0] === undefined ? undefined : toPolicyVersion(rows[0]);
    });
  }

  /** One version of the tenant, or `undefined` when it does not exist there (RLS and the filter). */
  async getVersion(tenantId: string, version: number): Promise<PolicyVersion | undefined> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantPolicies)
        .where(and(eq(tenantPolicies.tenantId, tenantId), eq(tenantPolicies.version, version)))
        .limit(1);
      return rows[0] === undefined ? undefined : toPolicyVersion(rows[0]);
    });
  }

  /** The tenant's history, newest first, without source text. */
  async listVersions(tenantId: string, limit: number): Promise<readonly PolicyVersionSummary[]> {
    return withTenant(this.options.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantPolicies)
        .where(eq(tenantPolicies.tenantId, tenantId))
        .orderBy(desc(tenantPolicies.version))
        .limit(limit);
      return rows.map((row) => toSummary(row));
    });
  }

  /**
   * Appends a new version (the next number for the tenant). The very first version of a tenant is always
   * the empty tenant policy: it is written first, inactive, in the same transaction. Nothing is updated.
   */
  async createVersion(input: NewPolicyVersion): Promise<PolicyVersion> {
    return withTenant(this.options.db, input.tenantId, async (tx) => {
      await lockTenantPolicies(tx, input.tenantId);
      const [latest] = await tx
        .select({ version: tenantPolicies.version })
        .from(tenantPolicies)
        .where(eq(tenantPolicies.tenantId, input.tenantId))
        .orderBy(desc(tenantPolicies.version))
        .limit(1);
      if (latest === undefined) {
        await this.insertVersion(tx, {
          tenantId: input.tenantId,
          version: 1,
          cedarSource: '',
          sha256: EMPTY_SOURCE_SHA256,
          ruleBuilderJson: null,
          note: 'initial empty tenant policy',
          actorId: input.actorId,
        });
      }
      const next = (latest?.version ?? 1) + 1;
      return this.insertVersion(tx, { ...input, version: next });
    });
  }

  /** Makes `version` the active one. Refused unless the caller's expectation holds (optimistic check). */
  async activate(input: {
    readonly tenantId: string;
    readonly version: number;
    readonly expectedActiveVersion: number | null;
    readonly actorId: string;
  }): Promise<ActivationResult> {
    return this.movePointer(input, 'policy.activated');
  }

  /** Moves the active pointer back to `toVersion`, an earlier version. History is kept; nothing is deleted. */
  async rollback(input: {
    readonly tenantId: string;
    readonly toVersion: number;
    readonly expectedActiveVersion: number;
    readonly actorId: string;
  }): Promise<ActivationResult> {
    return this.movePointer(
      { ...input, version: input.toVersion, expectedActiveVersion: input.expectedActiveVersion },
      'policy.rolled_back',
    );
  }

  private async movePointer(
    input: {
      readonly tenantId: string;
      readonly version: number;
      readonly expectedActiveVersion: number | null;
      readonly actorId: string;
    },
    kind: 'policy.activated' | 'policy.rolled_back',
  ): Promise<ActivationResult> {
    return withTenant(this.options.db, input.tenantId, async (tx) => {
      await lockTenantPolicies(tx, input.tenantId);
      const [target] = await tx
        .select()
        .from(tenantPolicies)
        .where(
          and(
            eq(tenantPolicies.tenantId, input.tenantId),
            eq(tenantPolicies.version, input.version),
          ),
        )
        .limit(1);
      if (target === undefined) throw new PolicyVersionNotFoundError(input.version);

      const [current] = await tx
        .select()
        .from(tenantPolicies)
        .where(and(eq(tenantPolicies.tenantId, input.tenantId), eq(tenantPolicies.active, true)))
        .limit(1)
        .for('update');
      const previousVersion = current?.version ?? null;
      if (previousVersion !== input.expectedActiveVersion) {
        throw new ConcurrencyError('policy active version');
      }
      if (current?.id === target.id) {
        return { record: toPolicyVersion(target), previousVersion, changed: false };
      }
      if (current !== undefined) {
        await tx
          .update(tenantPolicies)
          .set({ active: false })
          .where(eq(tenantPolicies.id, current.id));
      }
      const [activated] = await tx
        .update(tenantPolicies)
        .set({ active: true })
        .where(eq(tenantPolicies.id, target.id))
        .returning();
      if (activated === undefined) throw new ConcurrencyError('policy active version');

      const event: TenantPolicyAuditEvent =
        kind === 'policy.rolled_back'
          ? {
              action: 'policy.rolled_back',
              tenantId: input.tenantId,
              actorId: input.actorId,
              toVersion: input.version,
              previousVersion,
            }
          : {
              action: 'policy.activated',
              tenantId: input.tenantId,
              actorId: input.actorId,
              version: input.version,
              previousVersion,
            };
      await this.options.audit(event, tx);
      return { record: toPolicyVersion(activated), previousVersion, changed: true };
    });
  }

  private async insertVersion(
    tx: TenantTx,
    input: NewPolicyVersion & { readonly version: number },
  ): Promise<PolicyVersion> {
    const [row] = await tx
      .insert(tenantPolicies)
      .values({
        tenantId: input.tenantId,
        version: input.version,
        cedarSource: input.cedarSource,
        sha256: input.sha256,
        ruleBuilderJson: input.ruleBuilderJson ?? null,
        author: input.actorId,
        note: input.note ?? null,
        active: false,
      })
      .returning();
    if (row === undefined) throw new NotFoundError('policy version was not written');
    await this.options.audit(
      {
        action: 'policy.version.created',
        tenantId: input.tenantId,
        actorId: input.actorId,
        version: input.version,
        sha256: input.sha256,
      },
      tx,
    );
    return toPolicyVersion(row);
  }
}
