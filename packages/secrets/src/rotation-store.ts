import { AppError } from '@blackwing/errors';

import type { Envelope } from './envelope.js';
import type { RunInTenant } from './resolve-store.js';
import type { RewrapCandidate, RotationRecord, RotationStore } from './rotation.js';
import type { SecretBackend, SecretStatus } from '@blackwing/contracts';

/**
 * Postgres-backed {@link RotationStore} over `secrets` and `secret_versions` (SECRETS-012). Every call runs
 * in the tenant's RLS context, so a rewrap or rotation can never address another tenant's rows.
 *
 * Concurrency: each call is its own transaction. A value rotation is guarded by an optimistic check on
 * `current_version` (the commit fails when another rotation won), and a rewrap write is guarded by the
 * version it read, so a stale pass cannot overwrite a newer envelope.
 */

const RECORD_SQL = `SELECT id, tenant_id, purpose, backend, status, current_version, envelope, external_locator
  FROM secrets WHERE id = $1 AND tenant_id = $2`;

/** Moves the secret to the next version only if it is still at the version the rotation read. */
const ADVANCE_SQL = `UPDATE secrets SET envelope = $3, current_version = $4
  WHERE id = $1 AND tenant_id = $2 AND current_version = $5 AND backend = 'openbao'
  RETURNING id`;

/** Records the superseded version, keeping an earlier retirement if the row already had one. */
const RETIRE_SQL = `INSERT INTO secret_versions (tenant_id, secret_id, version, envelope, external_locator, retired_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (secret_id, version) DO UPDATE SET retired_at = EXCLUDED.retired_at`;

const NEXT_VERSION_SQL = `INSERT INTO secret_versions (tenant_id, secret_id, version, envelope)
  VALUES ($1, $2, $3, $4)`;

/**
 * DEKs of one KEK below the target, from both the current rows and the history. A version that is also the
 * current one appears twice (once per source) and both copies are re-wrapped. External secrets are excluded.
 */
const BATCH_SQL = `SELECT source, secret_id, version, envelope FROM (
    SELECT 'current' AS source, s.id AS secret_id, s.current_version AS version, s.envelope
      FROM secrets s
     WHERE s.tenant_id = $1 AND s.backend = 'openbao' AND s.envelope->>'kekKey' = $2
       AND (s.envelope->>'kekVersion')::int < $3
    UNION ALL
    SELECT 'version' AS source, v.secret_id, v.version, v.envelope
      FROM secret_versions v JOIN secrets s ON s.id = v.secret_id AND s.tenant_id = v.tenant_id
     WHERE v.tenant_id = $1 AND s.backend = 'openbao' AND v.envelope->>'kekKey' = $2
       AND (v.envelope->>'kekVersion')::int < $3
  ) candidates
  WHERE ($4::uuid IS NULL OR (secret_id, version, source) > ($4::uuid, $5::int, $6::text))
  ORDER BY secret_id, version, source
  LIMIT $7`;

const SAVE_CURRENT_SQL = `UPDATE secrets SET envelope = $4
  WHERE id = $1 AND tenant_id = $2 AND current_version = $3 RETURNING id`;
const SAVE_VERSION_SQL = `UPDATE secret_versions SET envelope = $4
  WHERE secret_id = $1 AND tenant_id = $2 AND version = $3 RETURNING secret_id`;

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function envelopeOf(value: unknown): Envelope {
  const object = asObject(value);
  if (object === null)
    throw new AppError('INTERNAL', 'unexpected envelope shape in the rewrap batch');
  return object as unknown as Envelope;
}

function integerOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new AppError('INTERNAL', 'unexpected integer column in rotation');
  return n;
}

/** Postgres-backed rotation persistence (see the module comment). */
export function createPgRotationStore(runInTenant: RunInTenant): RotationStore {
  return {
    loadForRotation: (tenantId, secretId) =>
      runInTenant(tenantId, async (tx): Promise<RotationRecord | null> => {
        const row = (await tx.query(RECORD_SQL, [secretId, tenantId])).rows[0];
        if (row === undefined) return null;
        return {
          id: String(row.id),
          tenantId: String(row.tenant_id),
          purpose: typeof row.purpose === 'string' ? row.purpose : null,
          backend: row.backend as SecretBackend,
          status: row.status as SecretStatus,
          currentVersion: integerOf(row.current_version),
          envelope: asObject(row.envelope) as unknown as Envelope | null,
          externalLocator: asObject(row.external_locator),
        };
      }),

    commitRotation: (tenantId, commit) =>
      runInTenant(tenantId, async (tx) => {
        const next = commit.next;
        const advanced = await tx.query(ADVANCE_SQL, [
          commit.secretId,
          tenantId,
          next.envelope,
          next.version,
          commit.expectedVersion,
        ]);
        if (advanced.rows.length === 0) return false;
        await tx.query(RETIRE_SQL, [
          tenantId,
          commit.secretId,
          commit.previous.version,
          commit.previous.envelope,
          commit.previous.externalLocator,
          commit.previous.retiredAt,
        ]);
        await tx.query(NEXT_VERSION_SQL, [tenantId, commit.secretId, next.version, next.envelope]);
        return true;
      }),

    nextRewrapBatch: (tenantId, kekKey, beforeVersion, after, limit) =>
      runInTenant(tenantId, async (tx) => {
        const rows = (
          await tx.query(BATCH_SQL, [
            tenantId,
            kekKey,
            beforeVersion,
            after?.secretId ?? null,
            after?.version ?? 0,
            after?.source ?? '',
            limit,
          ])
        ).rows;
        return rows.map((row): RewrapCandidate => ({
          source: row.source === 'version' ? 'version' : 'current',
          secretId: String(row.secret_id),
          version: integerOf(row.version),
          envelope: envelopeOf(row.envelope),
        }));
      }),

    saveRewrap: (tenantId, candidate: RewrapCandidate, envelope: Envelope) =>
      runInTenant(tenantId, async (tx) => {
        const sql = candidate.source === 'current' ? SAVE_CURRENT_SQL : SAVE_VERSION_SQL;
        const saved = await tx.query(sql, [
          candidate.secretId,
          tenantId,
          candidate.version,
          envelope,
        ]);
        return saved.rows.length > 0;
      }),
  };
}
