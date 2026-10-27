import { AppError } from '@blackwing/errors';

import type { Envelope } from './envelope.js';
import type { SecretRecord, SecretStore } from './resolve.js';
import type { SecretBackend, SecretStatus, SecretType } from '@blackwing/contracts';

/** The slice of a tenant transaction the store needs (a `pg` client inside `withTenant` satisfies it). */
export interface TenantSql {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: Record<string, unknown>[] }>;
}

/** Runs `fn` in a transaction with `app.tenant_id` set (`withTenant`), so RLS scopes every read. */
export type RunInTenant = <T>(tenantId: string, fn: (tx: TenantSql) => Promise<T>) => Promise<T>;

const SECRET_SQL = `SELECT id, tenant_id, type, purpose, backend, status, current_version, envelope, external_locator
  FROM secrets WHERE id = $1 AND tenant_id = $2`;
const VERSION_SQL = `SELECT envelope, external_locator
  FROM secret_versions WHERE secret_id = $1 AND tenant_id = $2 AND version = $3`;

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Postgres-backed {@link SecretStore} over `secrets` and `secret_versions` (SECRETS-003). The tenant is both
 * a query predicate and the RLS context, so another tenant's secret is simply absent (`null`).
 */
export function createPgSecretStore(runInTenant: RunInTenant): SecretStore {
  return {
    load: (tenantId, secretId, version) =>
      runInTenant(tenantId, async (tx) => {
        const row = (await tx.query(SECRET_SQL, [secretId, tenantId])).rows[0];
        if (row === undefined) return null;
        const current = Number(row.current_version);
        const pinned = version ?? current;
        let source: Record<string, unknown> = row;
        if (pinned !== current) {
          const old = (await tx.query(VERSION_SQL, [secretId, tenantId, pinned])).rows[0];
          if (old === undefined) return null;
          source = old;
        }
        if (
          typeof row.id !== 'string' ||
          typeof row.tenant_id !== 'string' ||
          !Number.isInteger(current)
        ) {
          throw new AppError('INTERNAL', 'unexpected secrets row shape');
        }
        return {
          id: row.id,
          tenantId: row.tenant_id,
          type: (row.type ?? null) as SecretType | null,
          purpose: typeof row.purpose === 'string' ? row.purpose : null,
          backend: row.backend as SecretBackend,
          status: row.status as SecretStatus,
          version: pinned,
          envelope: asObject(source.envelope) as unknown as Envelope | null,
          externalLocator: asObject(source.external_locator),
        } satisfies SecretRecord;
      }),
  };
}
