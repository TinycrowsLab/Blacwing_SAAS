import { and, count, eq, gte, sql, type SQL } from 'drizzle-orm';

import {
  type Database,
  memberships,
  signups,
  tenants,
  type TenantTx,
  users,
  withTenant,
} from '@blackwing/db';
import { InternalError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { slugBase, slugCandidate } from './slug.js';

import type {
  PendingSignup,
  RequestThrottle,
  SignupStore,
  VerifySignupInput,
  VerifySignupOutcome,
} from './ports.js';
import type { AuditEmitter, AuditSqlTx } from '@blackwing/audit';

/** Collision attempts before a slug is given up on (`-2` ... `-N`); far above any real contention. */
const SLUG_ATTEMPTS_MAX = 1000;

/** The owner of a self-service tenant is its Org Owner/Admin persona (CONTEXT_PACK §1.2). */
const OWNER_ROLES = ['org_admin'];

const PLACEHOLDER = /\$(\d+)/g;

/** Splits `text` at its `$n` placeholders into a Drizzle `sql` with bound parameters (never interpolated). */
function toSql(text: string, values: readonly unknown[]): SQL {
  const chunks: SQL[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]) - 1;
    if (!(index in values)) throw new RangeError(`missing value for placeholder ${match[0]}`);
    chunks.push(sql.raw(text.slice(last, match.index)), sql`${values[index]}`);
    last = match.index + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks, sql.raw(''));
}

/** Runs the audit package's parameterised SQL on the verify transaction, so the event joins it. */
function auditTx(tx: TenantTx): AuditSqlTx {
  return {
    async query(text, values = []) {
      const result = await tx.execute(toSql(text, values));
      return { rows: result.rows };
    },
  };
}

export interface PostgresSignupStoreDeps {
  /** The app-role database (never the owner role). */
  readonly db: Database;
  /** `createAuditEmitter()`: events are appended to the chain inside the verify transaction. */
  readonly audit: Pick<AuditEmitter, 'emitAuditInTx'>;
}

/**
 * {@link SignupStore} on Postgres. `signups` and `users` are not tenant tables, so `request` runs in a plain
 * transaction. `verify` runs in `withTenant` for the tenant it may create: the `tenants` and `memberships`
 * row-level-security policies then admit exactly that tenant's two inserts and nothing else.
 */
export class PostgresSignupStore implements SignupStore {
  constructor(private readonly deps: PostgresSignupStoreDeps) {}

  async request(
    signup: PendingSignup,
    throttle: RequestThrottle,
  ): Promise<{ readonly id: string } | null> {
    return this.deps.db.transaction(async (tx) => {
      // Serialises requests of one address, so the count below cannot be raced past the limit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${signup.email}, 0))`);
      const [recent] = await tx
        .select({ n: count() })
        .from(signups)
        .where(and(eq(signups.email, signup.email), gte(signups.createdAt, throttle.since)));
      if ((recent?.n ?? 0) >= throttle.max) return null;

      await tx
        .update(signups)
        .set({ status: 'cancelled' })
        .where(and(eq(signups.email, signup.email), eq(signups.status, 'pending')));
      const id = newId();
      await tx.insert(signups).values({ id, ...signup });
      return { id };
    });
  }

  async verify(input: VerifySignupInput): Promise<VerifySignupOutcome> {
    // The tenant id is chosen up front because the transaction is scoped to it; it is used only if the
    // token turns out to be good, and the transaction rolls back otherwise.
    const tenantId = newId();
    return withTenant(this.deps.db, tenantId, async (tx) => {
      // The row lock makes concurrent verifies of one token take turns: the second sees `verified`.
      const [row] = await tx
        .select()
        .from(signups)
        .where(eq(signups.tokenHash, input.tokenHash))
        .for('update');
      if (row?.status !== 'pending') return { kind: 'invalid' };
      if (row.expiresAt <= input.now) {
        await tx.update(signups).set({ status: 'expired' }).where(eq(signups.id, row.id));
        return { kind: 'invalid' };
      }

      // `keycloak_sub` is filled in by IAM at first login; the placeholder follows the seed convention.
      const userId = newId();
      const inserted = await tx
        .insert(users)
        .values({ id: userId, keycloakSub: `pending:${userId}`, email: row.email })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      await tx.update(signups).set({ status: 'verified' }).where(eq(signups.id, row.id));
      if (inserted.length === 0) {
        // The address already has an account: never a second tenant. A concurrent verify of another
        // signup for it waits on the unique index above and lands here too.
        return { kind: 'existing_account', signupId: row.id };
      }

      const slug = await this.insertTenant(tx, {
        tenantId,
        base: row.desiredSlug ?? slugBase(row.orgName),
        name: row.orgName,
        region: input.region,
      });
      await tx.insert(memberships).values({ tenantId, userId, roles: OWNER_ROLES });

      const audit = auditTx(tx);
      const actor = { type: 'user', id: userId } as const;
      await this.deps.audit.emitAuditInTx(audit, {
        tenantId,
        action: 'signup.verified',
        actor,
        target: { type: 'user', id: userId },
        outcome: 'success',
        metadata: { signupId: row.id },
        dedupeKey: `signup.verified:${row.id}`,
      });
      await this.deps.audit.emitAuditInTx(audit, {
        tenantId,
        action: 'tenant.created',
        actor,
        target: { type: 'tenant', id: tenantId },
        outcome: 'success',
        metadata: { slug, region: input.region, plan: 'free', signupId: row.id },
        dedupeKey: `tenant.created:${tenantId}`,
      });
      return {
        kind: 'created',
        signupId: row.id,
        tenantId,
        userId,
        slug,
        orgName: row.orgName,
      };
    });
  }

  /**
   * Inserts the tenant under the first free slug (`base`, `base-2`, ...). `ON CONFLICT DO NOTHING` makes a
   * lost race a normal outcome instead of an aborted transaction: a concurrent signup holding the same
   * slug makes this insert wait for its commit, then move to the next candidate.
   */
  private async insertTenant(
    tx: TenantTx,
    tenant: {
      readonly tenantId: string;
      readonly base: string;
      readonly name: string;
      readonly region: string;
    },
  ): Promise<string> {
    for (let attempt = 1; attempt <= SLUG_ATTEMPTS_MAX; attempt += 1) {
      const slug = slugCandidate(tenant.base, attempt);
      const rows = await tx
        .insert(tenants)
        .values({
          id: tenant.tenantId,
          slug,
          name: tenant.name,
          status: 'active',
          region: tenant.region,
          plan: 'free',
        })
        .onConflictDoNothing({ target: tenants.slug })
        .returning({ id: tenants.id });
      if (rows.length > 0) return slug;
    }
    throw new InternalError('no free tenant slug');
  }
}
