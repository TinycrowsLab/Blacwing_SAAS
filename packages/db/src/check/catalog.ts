// Database-vs-snapshot comparison for the drift check (DB-002). After the committed migrations are
// applied to a scratch Postgres 16 + pgvector, the live catalogue must match drizzle-kit's latest
// schema snapshot: a hand-edited migration that diverges from the schema it claims shows up here.
// Both sides are reduced to sorted lines (`column public.t.c uuid not null`), so the diff is readable.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { migrationPrefix } from './journal.js';

import type pg from 'pg';

const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  typeSchema: z.string().optional(),
  notNull: z.boolean(),
  isUnique: z.boolean().optional(),
  uniqueName: z.string().optional(),
});
const named = z.record(z.string(), z.object({ name: z.string() }));
const tableSchema = z.object({
  name: z.string(),
  schema: z.string(),
  columns: z.record(z.string(), columnSchema),
  indexes: named,
  foreignKeys: named,
  compositePrimaryKeys: named,
  uniqueConstraints: named,
  checkConstraints: named,
  policies: named,
  isRLSEnabled: z.boolean(),
});
const snapshotSchema = z.object({
  tables: z.record(z.string(), tableSchema),
  enums: z.record(
    z.string(),
    z.object({ name: z.string(), schema: z.string(), values: z.array(z.string()) }),
  ),
});

/** drizzle-kit type spellings and Postgres `format_type` spellings that mean the same type. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  varchar: 'character varying',
  char: 'character',
  timestamp: 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  time: 'time without time zone',
  timetz: 'time with time zone',
  serial: 'integer',
  smallserial: 'smallint',
  bigserial: 'bigint',
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
};

/** Normalises a type name so drizzle-kit's and Postgres' spellings compare equal. */
export function normaliseType(type: string): string {
  const compact = type
    .trim()
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll(/\s*,\s*/gu, ',');
  const match = /^([a-z][a-z0-9_ ]*?)\s*(\(.*\))?((?:\[\])*)$/u.exec(compact);
  if (match === null) return compact;
  const [, base = compact, modifier = '', array = ''] = match;
  const unqualified = base.replace(/^public\./u, '');
  const aliased = TYPE_ALIASES[unqualified] ?? unqualified;
  // `timestamp(3) with time zone`: Postgres puts the precision after the base word.
  const withTz = /^(time|timestamp) (with|without) time zone$/u.exec(aliased);
  if (withTz !== null && modifier !== '') {
    return `${withTz[1] ?? ''}${modifier} ${withTz[2] ?? ''} time zone${array}`;
  }
  return `${aliased}${modifier}${array}`;
}

/** The catalogue lines drizzle-kit's snapshot (`meta/<prefix>_snapshot.json`) implies. */
export function expectedCatalog(snapshot: unknown): string[] {
  const parsed = snapshotSchema.parse(snapshot);
  const lines: string[] = [];
  for (const table of Object.values(parsed.tables)) {
    const t = `${table.schema === '' ? 'public' : table.schema}.${table.name}`;
    lines.push(`table ${t}`);
    for (const column of Object.values(table.columns)) {
      lines.push(
        `column ${t}.${column.name} ${normaliseType(column.type)}${column.notNull ? ' not null' : ''}`,
      );
      if (column.isUnique === true) {
        lines.push(
          `constraint ${t}.${column.uniqueName ?? `${table.name}_${column.name}_unique`} unique`,
        );
      }
    }
    for (const index of Object.values(table.indexes)) lines.push(`index ${t}.${index.name}`);
    for (const [kind, group] of [
      ['foreign key', table.foreignKeys],
      ['primary key', table.compositePrimaryKeys],
      ['unique', table.uniqueConstraints],
      ['check', table.checkConstraints],
    ] as const) {
      for (const constraint of Object.values(group)) {
        lines.push(`constraint ${t}.${constraint.name} ${kind}`);
      }
    }
    for (const policy of Object.values(table.policies)) lines.push(`policy ${t}.${policy.name}`);
    const rls = table.isRLSEnabled || Object.keys(table.policies).length > 0;
    lines.push(`rls ${t} ${rls ? 'enabled' : 'disabled'}`);
  }
  for (const enumType of Object.values(parsed.enums)) {
    lines.push(`enum ${enumType.schema}.${enumType.name} (${enumType.values.join(', ')})`);
  }
  return lines.toSorted();
}

/** Reads the newest snapshot of a migrations folder (the one of the last journal entry). */
export function latestSnapshot(migrationsDir: string, lastTag: string): unknown {
  const file = path.join(migrationsDir, 'meta', `${migrationPrefix(lastTag)}_snapshot.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const CATALOG_SQL = String.raw`
WITH rels AS (
  SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1)
)
SELECT 'table ' || r.schema || '.' || r.name AS line FROM rels r
UNION ALL
SELECT 'column ' || r.schema || '.' || r.name || '.' || a.attname || ' ' ||
       format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
  FROM rels r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'index ' || r.schema || '.' || r.name || '.' || ic.relname
  FROM rels r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
UNION ALL
SELECT 'constraint ' || r.schema || '.' || r.name || '.' || k.conname || ' ' ||
       CASE k.contype WHEN 'f' THEN 'foreign key' WHEN 'p' THEN 'primary key'
                      WHEN 'u' THEN 'unique' ELSE 'check' END
  FROM rels r JOIN pg_constraint k ON k.conrelid = r.oid
 WHERE k.contype IN ('f', 'u', 'c')
    OR (k.contype = 'p' AND array_length(k.conkey, 1) > 1)
UNION ALL
SELECT 'policy ' || p.schemaname || '.' || p.tablename || '.' || p.policyname
  FROM pg_policies p WHERE p.schemaname = ANY($1)
UNION ALL
SELECT 'rls ' || r.schema || '.' || r.name || CASE WHEN r.rls THEN ' enabled' ELSE ' disabled' END
  FROM rels r
UNION ALL
SELECT 'enum ' || n.nspname || '.' || t.typname || ' (' ||
       string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) || ')'
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE n.nspname = ANY($1)
 GROUP BY n.nspname, t.typname
`;

/** The live catalogue of `schemas` (default `public`) in the same line format. */
export async function introspectCatalog(
  client: pg.ClientBase,
  schemas: readonly string[] = ['public'],
): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(CATALOG_SQL, [schemas]);
  return rows
    .map(({ line }) => {
      const column = /^(column \S+) (.+?)( not null)?$/u.exec(line);
      return column === null
        ? line
        : `${column[1] ?? ''} ${normaliseType(column[2] ?? '')}${column[3] ?? ''}`;
    })
    .toSorted();
}

/** A unified-style diff: `- ` expected (snapshot) but not in the database, `+ ` the reverse. */
export function diffCatalog(expected: readonly string[], actual: readonly string[]): string[] {
  const want = new Set(expected);
  const have = new Set(actual);
  return [
    ...expected.filter((line) => !have.has(line)).map((line) => `- ${line}`),
    ...actual.filter((line) => !want.has(line)).map((line) => `+ ${line}`),
  ].toSorted((a, b) => a.slice(2).localeCompare(b.slice(2)));
}
