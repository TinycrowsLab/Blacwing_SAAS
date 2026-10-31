// The cross-tenant isolation suite (TENANT-003, CONTEXT_PACK §8.6): RLS, fail-closed context, pool
// leakage and role limits, proven as bw_app against the REAL migrations on Postgres 16
// (Testcontainers). Run it with `pnpm test:isolation`; it is a required CI check.
//
// New tenant table? The coverage meta-test fails until the table is added to ISOLATION_TABLES with a
// row seeder. Pattern for other epics: docs/architecture/tenant-isolation-tests.md.

import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import {
  expectAllTenantTablesForceRls,
  expectAppRoleCannotBypass,
  expectEveryTenantTableCovered,
  expectFailsClosedWithoutContext,
  expectNoLeakAcrossTransactions,
  expectRlsBlocksCrossTenant,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { publicId } from './columns.js';
import { migrateDatabase } from './index.js';
import { EMBEDDING_DIMENSIONS, toVectorLiteral } from './vector.js';

import type pg from 'pg';

type Seeder = (tx: pg.PoolClient, tenantId: string) => Promise<void>;

/** A valid 384-dim embedding for the `memories` seeder. */
const isolationVector = (): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);

/** A roster that is not the tenant's active one, so seeding twice never trips the one-active index. */
async function insertInactiveRoster(tx: pg.PoolClient, tenantId: string): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO oncall_rosters (id, tenant_id, name, timezone, active) VALUES ($1, $2, $3, 'UTC', false)`,
    [id, tenantId, `roster-${id}`],
  );
  return id;
}

/** One valid row per tenant table. The key is the table name: this list is the coverage note. */
const ISOLATION_TABLES: Record<string, Seeder> = {
  audit_events: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO audit_events (id, tenant_id, seq, occurred_at, action, severity, actor, target, outcome, hash)
       VALUES ($1, $2, 1, now(), 'gate2.decided', 'notice', '{"type":"system"}', '{"type":"run","id":"r"}', 'success', $3)`,
      [newId(), tenantId, createHash('sha256').update(randomBytes(8)).digest()],
    );
  },
  audit_export_subscriptions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO audit_export_subscriptions (id, tenant_id, kind, secret_ref)
       VALUES ($1, $2, 'splunk_hec', $3)`,
      [newId(), tenantId, `bw-secret://${tenantId}/${newId()}`],
    );
  },
  assessment_requests: async (tx, tenantId) => {
    const id = newId();
    await tx.query(
      `INSERT INTO assessment_requests (id, tenant_id, public_id, mode, objective, asset_ids, max_intrusiveness, budgets, trigger, requested_by)
       VALUES ($1, $2, $3, 'black', 'iso objective', '{}', 'passive', '{}', 'console', $4)`,
      [id, tenantId, `areq_${id.replaceAll('-', '')}`, newId()],
    );
  },
  findings: async (tx, tenantId) => {
    const id = newId();
    await tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'iso finding', 'iso_class', $5, '{"urlTemplate":"/iso"}', 'candidate', $5, $5, $5, 'CWE-89', 'A03')`,
      [
        id,
        tenantId,
        `fnd_${id.replaceAll('-', '')}`,
        createHash('sha256').update(randomBytes(8)).digest('hex'),
        newId(),
      ],
    );
  },
  finding_occurrences: async (tx, tenantId) => {
    const findingId = newId();
    const runId = newId();
    await tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'iso finding', 'iso_class', $5, '{"urlTemplate":"/iso"}', 'candidate', $6, $6, $6, 'CWE-89', 'A03')`,
      [
        findingId,
        tenantId,
        `fnd_${findingId.replaceAll('-', '')}`,
        createHash('sha256').update(randomBytes(8)).digest('hex'),
        newId(),
        runId,
      ],
    );
    await tx.query(
      `INSERT INTO finding_occurrences (id, tenant_id, finding_id, run_id, occurrence_status, detected_at)
       VALUES ($1, $2, $3, $4, 'detected', now())`,
      [newId(), tenantId, findingId, runId],
    );
  },
  finding_intel: async (tx, tenantId) => {
    const findingId = newId();
    await tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'iso finding', 'iso_class', $5, '{"urlTemplate":"/iso"}', 'candidate', $5, $5, $5, 'CWE-89', 'A03')`,
      [
        findingId,
        tenantId,
        `fnd_${findingId.replaceAll('-', '')}`,
        createHash('sha256').update(randomBytes(8)).digest('hex'),
        newId(),
      ],
    );
    await tx.query(
      `INSERT INTO finding_intel (tenant_id, finding_id, cve_id, kev, epss) VALUES ($1, $2, 'CVE-2024-12345', false, 0.1)`,
      [tenantId, findingId],
    );
  },
  evidence_items: async (tx, tenantId) => {
    const runId = newId();
    await tx.query(
      `INSERT INTO evidence_items (id, tenant_id, run_id, sequence, kind, role, object_key, sha256, size, content_type, captured_at, chain)
       VALUES ($1, $2, $3, 1, 'response', 'positive', $4, $5, 4, 'text/plain', now(), $5)`,
      [
        newId(),
        tenantId,
        runId,
        `${tenantId}/${runId}/iso`,
        createHash('sha256').update('iso').digest('hex'),
      ],
    );
  },
  repro_artifacts: async (tx, tenantId) => {
    const findingId = newId();
    const runId = newId();
    await tx.query(
      `INSERT INTO findings (id, tenant_id, public_id, fingerprint, title, class, asset_id, location, status, run_id, first_seen_run_id, last_seen_run_id, cwe_id, owasp_category)
       VALUES ($1, $2, $3, $4, 'iso finding', 'iso_class', $5, '{"urlTemplate":"/iso"}', 'candidate', $6, $6, $6, 'CWE-89', 'A03')`,
      [
        findingId,
        tenantId,
        `fnd_${findingId.replaceAll('-', '')}`,
        createHash('sha256').update(randomBytes(8)).digest('hex'),
        newId(),
        runId,
      ],
    );
    const rpaId = newId();
    await tx.query(
      `INSERT INTO repro_artifacts (id, public_id, tenant_id, finding_id, run_id, bundle_key, sha256, format_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '1')`,
      [
        rpaId,
        publicId('rpa', rpaId),
        tenantId,
        findingId,
        runId,
        `${tenantId}/${runId}/repro`,
        createHash('sha256').update('iso-repro').digest('hex'),
      ],
    );
  },
  input_manifests: async (tx, tenantId) => {
    await tx.query(`INSERT INTO input_manifests (id, tenant_id) VALUES ($1, $2)`, [
      newId(),
      tenantId,
    ]);
  },
  policies: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO policies (id, tenant_id, version, cedar_source, sha256, author)
       VALUES ($1, $2, 1, '', $3, $4)`,
      [newId(), tenantId, createHash('sha256').update('').digest('hex'), newId()],
    );
  },
  persona_overrides: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO persona_overrides (tenant_id, persona, max_turns) VALUES ($1, 'osint', 5)`,
      [tenantId],
    );
  },
  gate2_exceptions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO gate2_exceptions (id, tenant_id, run_id, session_id, tool_name, proposed_action,
         envelope_reason, intrusiveness, timeout_at, idempotency_key)
       VALUES ($1, $2, $3, 'sess-1', 'http.request', '{}', 'outside the envelope', 'state_changing',
         now() + interval '15 minutes', $4)`,
      [newId(), tenantId, newId(), newId()],
    );
  },
  cost_ledger: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO cost_ledger (id, tenant_id, run_id, stage, provider, model, price_table_id,
         input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, usage_event_id, occurred_at)
       VALUES ($1, $2, $3, 'execution', 'anthropic', 'claude-sonnet-5-5', $4, 100, 50, 0, 0, '0.0010000000', $5, now())`,
      [newId(), tenantId, newId(), isoPriceTableId, `iso-${newId()}`],
    );
  },
  kill_events: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO kill_events (id, tenant_id, scope, scope_ref_id, source, actor_type, actor_ref, reason)
       VALUES ($1, $2, 'run', $3, 'console', 'user', 'usr_test', 'stop the run')`,
      [newId(), tenantId, newId()],
    );
  },
  oncall_members: async (tx, tenantId) => {
    const rosterId = await insertInactiveRoster(tx, tenantId);
    await tx.query(
      `INSERT INTO oncall_members (id, tenant_id, roster_id, user_id, level, order_index)
       VALUES ($1, $2, $3, $4, 0, 0)`,
      [newId(), tenantId, rosterId, newId()],
    );
  },
  oncall_rosters: async (tx, tenantId) => {
    await insertInactiveRoster(tx, tenantId);
  },
  oncall_schedules: async (tx, tenantId) => {
    const rosterId = await insertInactiveRoster(tx, tenantId);
    await tx.query(
      `INSERT INTO oncall_schedules (id, tenant_id, roster_id, user_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, now(), now() + interval '1 day')`,
      [newId(), tenantId, rosterId, newId()],
    );
  },
  outbox: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO outbox (tenant_id, type, payload) VALUES ($1, 'audit.event', '{}')`,
      [tenantId],
    );
  },
  secrets: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO secrets (id, tenant_id, name, envelope) VALUES ($1, $2, 'iso-secret', '{"ct":"x"}')`,
      [newId(), tenantId],
    );
  },
  secret_versions: async (tx, tenantId) => {
    const secretId = newId();
    await tx.query(
      `INSERT INTO secrets (id, tenant_id, name, envelope) VALUES ($1, $2, 'iso-versioned', '{"ct":"x"}')`,
      [secretId, tenantId],
    );
    await tx.query(
      `INSERT INTO secret_versions (tenant_id, secret_id, version, envelope) VALUES ($1, $2, 1, '{"ct":"x"}')`,
      [tenantId, secretId],
    );
  },
  memories: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO memories (id, tenant_id, scope, kind, title, content, embedding, embed_model, embed_revision, source)
       VALUES ($1, $2, 'tenant', 'recon_fact', 'iso memory', 'iso content', $3::vector, 'bge-small-en-v1.5', 'rev-1', 'agent')`,
      [newId(), tenantId, toVectorLiteral(isolationVector())],
    );
  },
  memberships: async (tx, tenantId) => {
    // The membership's parent is the tenant row itself (FK), and `tenants` is RLS-keyed on its id, so
    // the row is inserted under its own tenant context (a foreign tenant id is refused by RLS).
    await tx.query(
      `INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'Isolation tenant', 'eu')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, `iso-${tenantId.replaceAll('-', '')}`],
    );
    // memberships references the global users table, so each row gets its own user (no RLS on users).
    const userId = newId();
    await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
      userId,
      `iso-${userId}`,
      `iso-${userId}@example.test`,
    ]);
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{admin}')`,
      [tenantId, userId],
    );
  },
  service_accounts: async (tx, tenantId) => {
    // The owner must be a member of the tenant (composite FK), so the row gets its own user and membership.
    await tx.query(
      `INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'Isolation tenant', 'eu')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, `iso-${tenantId.replaceAll('-', '')}`],
    );
    const ownerId = newId();
    await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
      ownerId,
      `iso-${ownerId}`,
      `iso-${ownerId}@example.test`,
    ]);
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, '{admin}')`,
      [tenantId, ownerId],
    );
    await tx.query(
      `INSERT INTO service_accounts (id, tenant_id, name, roles, owner_user_id) VALUES ($1, $2, 'iso-sa', '{}', $3)`,
      [newId(), tenantId, ownerId],
    );
  },
  assets: async (tx, tenantId) => {
    await insertAsset(tx, tenantId);
  },
  asset_credentials: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
       VALUES ($1, $2, $3, 'customer', 'openbao://secret/data/tenants/iso/customer', '{}'::jsonb, 'none')`,
      [newId(), tenantId, assetId],
    );
  },
  role_matrices: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix, active)
       VALUES ($1, $2, $3, 1, '{}'::jsonb, true)`,
      [newId(), tenantId, assetId],
    );
  },
  asset_tags: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO asset_tags (tenant_id, asset_id, key, value) VALUES ($1, $2, 'env', 'iso')`,
      [tenantId, assetId],
    );
  },
  asset_groups: async (tx, tenantId) => {
    await tx.query(`INSERT INTO asset_groups (id, tenant_id, name) VALUES ($1, $2, 'iso group')`, [
      newId(),
      tenantId,
    ]);
  },
  asset_group_members: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    const groupId = newId();
    await tx.query(
      `INSERT INTO asset_groups (id, tenant_id, name) VALUES ($1, $2, 'iso members')`,
      [groupId, tenantId],
    );
    await tx.query(
      `INSERT INTO asset_group_members (tenant_id, group_id, asset_id) VALUES ($1, $2, $3)`,
      [tenantId, groupId, assetId],
    );
  },
  verification_challenges: async (tx, tenantId) => {
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(
      `INSERT INTO verification_challenges (id, tenant_id, asset_id, method, token, expected_location, expires_at)
       VALUES ($1, $2, $3, 'dns_txt', $4, '_blackwing-challenge.iso.example', now() + interval '72 hours')`,
      [newId(), tenantId, assetId, `blackwing-site-verification=${'A'.repeat(52)}`],
    );
  },
  notification_channels: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO notification_channels (id, tenant_id, kind, name, config, status, created_by)
       VALUES ($1, $2, 'email', 'iso-channel', '{"addresses":["soc@example.test"]}', 'active', $3)`,
      [newId(), tenantId, newId()],
    );
  },
  soc_contacts: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO soc_contacts (id, tenant_id, name, email) VALUES ($1, $2, 'SOC desk', 'soc@example.test')`,
      [newId(), tenantId],
    );
  },
  soc_kill_tokens: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO soc_kill_tokens (id, tenant_id, scope, scope_ref_id, token_sha256, expires_at)
       VALUES ($1, $2, 'tenant', NULL, $3, now() + interval '1 day')`,
      [newId(), tenantId, createHash('sha256').update(randomBytes(32)).digest()],
    );
  },
  schedules: async (tx, tenantId) => {
    const saId = newId();
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
       VALUES ($1, $2, $3, $4::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '30 days', $5)`,
      [saId, tenantId, `sa_${randomBytes(8).toString('hex')}`, [newId()], newId()],
    );
    await tx.query(
      `INSERT INTO schedules (id, tenant_id, public_id, name, asset_ids, sa_id, mode, cron_expr, timezone, created_by)
       VALUES ($1, $2, $3, 'isolation', $4::uuid[], $5, 'grey', '0 2 * * *', 'UTC', $6)`,
      [newId(), tenantId, `sched_${randomBytes(13).toString('hex')}`, [newId()], saId, newId()],
    );
  },
  blackout_windows: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO blackout_windows (id, tenant_id, scope, starts_at, ends_at, created_by)
       VALUES ($1, $2, 'tenant', now(), now() + interval '1 hour', $3)`,
      [newId(), tenantId, newId()],
    );
  },
  standing_authorisations: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO standing_authorisations (id, tenant_id, public_id, asset_ids, scope_rules, max_intrusiveness, default_budgets, test_windows, valid_from, expires_at, requester_id)
       VALUES ($1, $2, $3, $4::uuid[], '{}', 'passive', '{}', '[]', now(), now() + interval '30 days', $5)`,
      [newId(), tenantId, `sa_${randomBytes(8).toString('hex')}`, [newId()], newId()],
    );
  },
  gate_decisions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO gate_decisions (decision_id, tenant_id, run_id, gate, kind, dedupe_key, summary, requested_at, timeout_at)
       VALUES ($1, $2, $3, 2, 'tool_deferred', $4, 'iso decision', now(), now() + interval '1 hour')`,
      [newId(), tenantId, newId(), `iso-${randomBytes(8).toString('hex')}`],
    );
  },
  authz_gate_decisions: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO authz_gate_decisions (id, tenant_id, gate, subject_type, subject_id, decision, auto)
       VALUES ($1, $2, 1, 'test_plan', $3, 'rejected', false)`,
      [newId(), tenantId, newId()],
    );
  },
  runs: async (tx, tenantId) => {
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [newId(), tenantId]);
  },
  // A manifest is keyed to a run of the same tenant (composite FK), so the seeder writes the run first.
  coverage_manifests: async (tx, tenantId) => {
    const runId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(`INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)`, [
      newId(),
      tenantId,
      runId,
    ]);
  },
  // A coverage row needs a manifest and a test case of the same tenant (composite FKs), so one seeder writes the chain.
  coverage_entries: async (tx, tenantId) => {
    const runId = newId();
    const planId = newId();
    const caseId = newId();
    const manifestId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [planId, tenantId, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget)
       VALUES ($1, $2, $3, 'passive', 'iso case', '[{"host":"iso.example.test"}]', '{"maxRequests":10}')`,
      [caseId, tenantId, planId],
    );
    await tx.query(`INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)`, [
      manifestId,
      tenantId,
      runId,
    ]);
    await tx.query(
      `INSERT INTO coverage_entries (id, tenant_id, manifest_id, test_case_id, title, class, targets, outcome, reason)
       VALUES ($1, $2, $3, $4, 'iso case', 'passive', '[{"host":"iso.example.test"}]', 'skipped', 'iso reason')`,
      [newId(), tenantId, manifestId, caseId],
    );
  },
  // A plan and its case need a run in the same tenant (composite FKs), so one seeder writes the chain.
  test_plans: async (tx, tenantId) => {
    const runId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [newId(), tenantId, runId],
    );
  },
  test_cases: async (tx, tenantId) => {
    const runId = newId();
    const planId = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [planId, tenantId, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget)
       VALUES ($1, $2, $3, 'passive', 'iso case', '[{"host":"iso.example.test"}]', '{"maxRequests":10}')`,
      [newId(), tenantId, planId],
    );
  },
  // A stored session names a run and an asset of its own tenant (composite FKs). Only ciphertext is written.
  role_sessions: async (tx, tenantId) => {
    const runId = newId();
    const assetId = await insertAsset(tx, tenantId);
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO role_sessions (id, tenant_id, run_id, asset_id, role_name, kind, enc_material, enc_key_ref, expires_at)
       VALUES ($1, $2, $3, $4, 'iso.role', 'cookie', '\\x00', 'tenant-iso@v1', now() + interval '1 hour')`,
      [newId(), tenantId, runId, assetId],
    );
  },
  // A journal entry names a run and a test case of its own tenant (composite FKs): one seeder writes the chain.
  reversal_journal_entries: async (tx, tenantId) => {
    const runId = newId();
    const planId = newId();
    const caseId = newId();
    const id = newId();
    await tx.query(`INSERT INTO runs (id, tenant_id) VALUES ($1, $2)`, [runId, tenantId]);
    await tx.query(
      `INSERT INTO test_plans (id, tenant_id, run_id, version) VALUES ($1, $2, $3, 1)`,
      [planId, tenantId, runId],
    );
    await tx.query(
      `INSERT INTO test_cases (id, tenant_id, test_plan_id, class, title, targets, budget)
       VALUES ($1, $2, $3, 'state_changing', 'iso case', '[{"host":"iso.example.test"}]', '{"maxRequests":10}')`,
      [caseId, tenantId, planId],
    );
    await tx.query(
      `INSERT INTO reversal_journal_entries (id, public_id, tenant_id, run_id, test_case_id, action, target, undo_instructions)
       VALUES ($1, $2, $3, $4, $5, 'iso action', '{"kind":"record","ref":"iso"}', '{"type":"restore_field","params":{}}')`,
      [id, `rvj_${id.replaceAll('-', '')}`, tenantId, runId, caseId],
    );
  },
  // A virtual model key (GATEWAY-002): the hash-gated resolve policy reveals nothing without the exact hash.
  virtual_keys: async (tx, tenantId) => {
    await tx.query(
      `INSERT INTO virtual_keys (id, tenant_id, run_id, session_id, key_prefix, key_sha256, scope, persona, expires_at)
       VALUES ($1, $2, $3, $4, 'bwk_ABCDEFGH', $5, '{"persona":"planner"}', 'planner', now() + interval '1 hour')`,
      [newId(), tenantId, newId(), newId(), createHash('sha256').update(randomBytes(32)).digest()],
    );
  },
};

/** An asset row (and the user that owns it, the users table being global). Returns the asset id. */
async function insertAsset(tx: pg.PoolClient, tenantId: string): Promise<string> {
  const userId = newId();
  await tx.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
    userId,
    `iso-${userId}`,
    `iso-${userId}@example.test`,
  ]);
  const assetId = newId();
  await tx.query(
    `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status)
     VALUES ($1, $2, $3, 'web_app', 'iso asset', $4::jsonb, 'dev', $5, 'unverified')`,
    [
      assetId,
      tenantId,
      publicId('asset', assetId),
      JSON.stringify([{ kind: 'url', value: 'https://iso.example.test' }]),
      userId,
    ],
  );
  return assetId;
}

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
/** A platform price table the cost ledger seeder pins to (price tables are operator-written, not tenant data). */
let isoPriceTableId = '';

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  isoPriceTableId = newId();
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bw_operator');
    await client.query(
      `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
         cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
       VALUES ($1, 'anthropic', 'claude-sonnet-5-5', 1, 3, 15, 3.75, 0.3, now(), $2)`,
      [isoPriceTableId, 'c'.repeat(64)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('every tenant table', () => {
  it('is covered by this suite (a new tenant table without tests fails here)', async () => {
    await expect(
      expectEveryTenantTableCovered(db.ownerPool, Object.keys(ISOLATION_TABLES)),
    ).resolves.toBeInstanceOf(Array);
  });

  it('has RLS enabled and forced, with a policy', async () => {
    await expect(expectAllTenantTablesForceRls(db.ownerPool)).resolves.toBeInstanceOf(Array);
  });
});

describe.each(Object.entries(ISOLATION_TABLES))('%s', (table, insertRow) => {
  it('RLS blocks cross-tenant reads and writes', async () => {
    await expect(
      expectRlsBlocksCrossTenant(db.appPool, table, { tenantA, tenantB, insertRow }),
    ).resolves.toBeUndefined();
  });

  it('fails closed (raises) without a tenant context', async () => {
    await expect(expectFailsClosedWithoutContext(db.appPool, table)).resolves.toBeUndefined();
  });
});

describe('connections and roles', () => {
  it('a reused pooled connection never leaks tenant context', async () => {
    await expect(
      expectNoLeakAcrossTransactions(db.appPool, tenantA, tenantB),
    ).resolves.toBeUndefined();
  });

  it('bw_app cannot bypass RLS or run DDL', async () => {
    await expect(expectAppRoleCannotBypass(db.appPool)).resolves.toBeUndefined();
  });
});

/** The suite must fail when isolation regresses: break it on purpose and require a failure. */
describe('negative: the suite catches regressions', () => {
  const policy = (name: string, missingOk: string): string =>
    `CREATE POLICY ${name}_p ON ${name} FOR ALL USING (tenant_id = current_setting('app.tenant_id'${missingOk})::uuid)
       WITH CHECK (tenant_id = current_setting('app.tenant_id'${missingOk})::uuid)`;

  it('fails on the fail-open form current_setting(..., true)', async () => {
    await db.ownerPool.query('CREATE TABLE iso_open (id int, tenant_id uuid NOT NULL)');
    try {
      await db.ownerPool.query('ALTER TABLE iso_open ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(policy('iso_open', ', true'));
      await db.ownerPool.query('GRANT SELECT, DELETE ON iso_open TO bw_app');
      await expect(expectFailsClosedWithoutContext(db.appPool, 'iso_open')).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_open');
    }
  });

  it('fails on a tenant table without RLS, and on one without FORCE', async () => {
    await db.ownerPool.query('CREATE TABLE iso_bare (tenant_id uuid NOT NULL)');
    try {
      await expect(expectAllTenantTablesForceRls(db.ownerPool)).rejects.toThrow();
      await db.ownerPool.query('ALTER TABLE iso_bare ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(policy('iso_bare', ''));
      await expect(expectAllTenantTablesForceRls(db.ownerPool)).rejects.toThrow();
      await expect(
        expectEveryTenantTableCovered(db.ownerPool, Object.keys(ISOLATION_TABLES)),
      ).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_bare');
    }
  });

  it('fails when the policy has no WITH CHECK or is missing', async () => {
    await db.ownerPool.query('CREATE TABLE iso_nocheck (id int, tenant_id uuid NOT NULL)');
    try {
      await db.ownerPool.query('ALTER TABLE iso_nocheck ENABLE ROW LEVEL SECURITY');
      await db.ownerPool.query(
        `CREATE POLICY p ON iso_nocheck FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
      );
      await db.ownerPool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON iso_nocheck TO bw_app');
      await db.ownerPool.query('ALTER POLICY p ON iso_nocheck WITH CHECK (true)');
      await expect(
        expectRlsBlocksCrossTenant(db.appPool, 'iso_nocheck', {
          tenantA,
          tenantB,
          insertRow: async (tx, tenantId) => {
            await tx.query('INSERT INTO iso_nocheck (id, tenant_id) VALUES (1, $1)', [tenantId]);
          },
        }),
      ).rejects.toThrow();
    } finally {
      await db.ownerPool.query('DROP TABLE iso_nocheck');
    }
  });
});
