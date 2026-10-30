import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgPolicy, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { idColumn, retention, tenantIdColumn, tenantIdIndex, timestamps } from '../columns.js';
import { embeddingColumn, hnswIndex } from '../vector.js';
import { TENANT_PREDICATE } from './columns.js';

/**
 * Agent memory and the curated technique knowledge base (MEMORY-001, CONTEXT_PACK §3.1, §7, §8.6, §8.7).
 * Both tables hold 384-dim embeddings (DB-005 `embeddingColumn()`) under an HNSW cosine index (`hnswIndex()`).
 *
 * `memories` is tenant-scoped: FORCE RLS through the DB-003 canonical policy (the `pgPolicy` below repeats
 * `rlsPolicySql('memories')`'s predicate; the migration appends FORCE and the grants). `technique_kb` is
 * platform-global (no `tenant_id`, no RLS): tenants may only SELECT it, and the pipeline role writes it.
 * Both migrations are generated from this file (`pnpm db:generate`) and reviewed.
 */

/** The allowed values of the closed sets, shared by the CHECK constraints below. */
const MEMORY_SCOPES = ['run', 'tenant'] as const;
const MEMORY_SOURCES = ['agent', 'operator', 'system', 'external'] as const;
const MEMORY_TRUST_LEVELS = ['untrusted', 'asserted', 'verified'] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

export const memories = pgTable(
  'memories',
  {
    id: idColumn(),
    tenantId: tenantIdColumn(),
    /** The run that wrote the memory; null for tenant-wide memories. */
    runId: uuid('run_id'),
    scope: text('scope').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    embedding: embeddingColumn().notNull(),
    embedModel: text('embed_model').notNull(),
    embedRevision: text('embed_revision').notNull(),
    source: text('source').notNull(),
    trust: text('trust').notNull().default('untrusted'),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
    /** Set when `content` already went through redaction; raw secrets are never stored (§8.7). */
    redacted: boolean('redacted').notNull().default(false),
    ...timestamps(),
    ...retention(),
  },
  (t) => [
    tenantIdIndex('memories', t.tenantId),
    index('memories_tenant_run_idx').on(t.tenantId, t.runId),
    index('memories_tenant_kind_idx').on(t.tenantId, t.kind),
    index('memories_tenant_scope_idx').on(t.tenantId, t.scope),
    // Prepared for dedup (MEMORY-009): the writer records a stable key in provenance.
    index('memories_dedup_key_idx').on(sql`((${t.provenance}->>'dedup_key'))`),
    hnswIndex('memories', t.embedding),
    check('memories_scope_check', sql`${t.scope} IN (${inList(MEMORY_SCOPES)})`),
    check('memories_run_scope_check', sql`${t.scope} <> 'run' OR ${t.runId} IS NOT NULL`),
    check('memories_kind_check', sql`length(btrim(${t.kind})) > 0`),
    check('memories_title_check', sql`length(btrim(${t.title})) > 0`),
    check('memories_content_check', sql`length(btrim(${t.content})) > 0`),
    check('memories_embed_model_check', sql`length(btrim(${t.embedModel})) > 0`),
    check('memories_embed_revision_check', sql`length(btrim(${t.embedRevision})) > 0`),
    check('memories_source_check', sql`${t.source} IN (${inList(MEMORY_SOURCES)})`),
    check('memories_trust_check', sql`${t.trust} IN (${inList(MEMORY_TRUST_LEVELS)})`),
    check('memories_provenance_check', sql`jsonb_typeof(${t.provenance}) = 'object'`),
    pgPolicy('memories_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: TENANT_PREDICATE,
      withCheck: TENANT_PREDICATE,
    }),
  ],
);

/** Platform-global curated techniques (no tenant key). Tenants read it; only the pipeline role writes it. */
export const techniqueKb = pgTable(
  'technique_kb',
  {
    id: idColumn(),
    techniqueKey: text('technique_key').notNull().unique(),
    title: text('title'),
    body: text('body'),
    owaspRefs: text('owasp_refs').array(),
    wstgRefs: text('wstg_refs').array(),
    cweIds: text('cwe_ids').array(),
    embedding: embeddingColumn().notNull(),
    embedModel: text('embed_model').notNull(),
    embedRevision: text('embed_revision').notNull(),
    version: text('version'),
    ...timestamps(),
  },
  (t) => [
    hnswIndex('technique_kb', t.embedding),
    check('technique_kb_technique_key_check', sql`length(btrim(${t.techniqueKey})) > 0`),
    check('technique_kb_embed_model_check', sql`length(btrim(${t.embedModel})) > 0`),
    check('technique_kb_embed_revision_check', sql`length(btrim(${t.embedRevision})) > 0`),
  ],
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type TechniqueKbRow = typeof techniqueKb.$inferSelect;
export type NewTechniqueKbRow = typeof techniqueKb.$inferInsert;
