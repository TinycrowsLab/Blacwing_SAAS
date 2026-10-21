// Forward-only production guard for migrations (DB-002, CONTEXT_PACK §5: "forward-only in prod").
// Pure and deterministic: it scans migration SQL for statements that lose data (or weaken RLS) and
// refuses them, and any `down` migration, in production unless ALLOW_DESTRUCTIVE_MIGRATION=1.

/** Why a statement is considered destructive. */
export type DestructiveKind = 'drop' | 'truncate' | 'delete' | 'rls_weakening';

/** One destructive statement found in a migration. */
export interface DestructiveStatement {
  readonly kind: DestructiveKind;
  /** The matched text, upper-cased and whitespace-collapsed (e.g. `DROP TABLE`). */
  readonly match: string;
}

const DESTRUCTIVE_PATTERNS: readonly { kind: DestructiveKind; pattern: RegExp }[] = [
  {
    kind: 'drop',
    pattern:
      /\bDROP\s+(?:TABLE|SCHEMA|DATABASE|TYPE|DOMAIN|SEQUENCE|EXTENSION|COLUMN|OWNED|MATERIALIZED\s+VIEW)\b/giu,
  },
  { kind: 'truncate', pattern: /\bTRUNCATE\b/giu },
  { kind: 'delete', pattern: /\bDELETE\s+FROM\b/giu },
  {
    kind: 'rls_weakening',
    pattern: /\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b|\bBYPASSRLS\b/giu,
  },
];

/** Removes `--` line comments and block comments so commented-out SQL is never matched. */
export function stripSqlComments(sql: string): string {
  return sql.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ').replaceAll(/--[^\n]*/gu, ' ');
}

/** Every destructive statement in `sql`, in source order. */
export function findDestructiveStatements(sql: string): DestructiveStatement[] {
  const code = stripSqlComments(sql);
  const found: { index: number; statement: DestructiveStatement }[] = [];
  for (const { kind, pattern } of DESTRUCTIVE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      found.push({
        index: match.index,
        statement: { kind, match: match[0].replaceAll(/\s+/gu, ' ').toUpperCase() },
      });
    }
  }
  return found.toSorted((a, b) => a.index - b.index).map((entry) => entry.statement);
}

/** The environment the guard reads (a subset of `process.env`). */
export interface MigrationGuardEnv {
  readonly NODE_ENV?: string | undefined;
  readonly ALLOW_DESTRUCTIVE_MIGRATION?: string | undefined;
}

/** `true` only for `NODE_ENV=production`. */
export function isProductionEnv(env: MigrationGuardEnv): boolean {
  return env.NODE_ENV === 'production';
}

/** The explicit override: exactly `ALLOW_DESTRUCTIVE_MIGRATION=1` (unset by default). */
export function destructiveMigrationAllowed(env: MigrationGuardEnv): boolean {
  return env.ALLOW_DESTRUCTIVE_MIGRATION === '1';
}

/** Thrown when the production guard refuses a migration. Nothing has been applied. */
export class DestructiveMigrationError extends Error {
  readonly version: string;
  readonly direction: 'up' | 'down';
  readonly statements: readonly DestructiveStatement[];

  constructor(
    version: string,
    direction: 'up' | 'down',
    statements: readonly DestructiveStatement[],
  ) {
    const what =
      direction === 'down'
        ? 'a down migration'
        : `destructive statements (${statements.map((s) => s.match).join(', ')})`;
    super(
      `migration ${version} contains ${what}: refused in production (forward-only). ` +
        'Ship a forward migration instead, or set ALLOW_DESTRUCTIVE_MIGRATION=1 for a reviewed exception.',
    );
    this.name = 'DestructiveMigrationError';
    this.version = version;
    this.direction = direction;
    this.statements = statements;
  }
}

/** A migration about to run, as the guard sees it. */
export interface GuardedMigration {
  readonly version: string;
  readonly direction: 'up' | 'down';
  readonly sql: string;
}

/**
 * Throws {@link DestructiveMigrationError} when `migration` may not run in `env`: in production a
 * `down` migration, or an `up` migration with a destructive statement, needs the explicit flag.
 * Outside production everything is allowed (dev and test reset databases freely).
 */
export function assertMigrationAllowed(migration: GuardedMigration, env: MigrationGuardEnv): void {
  if (!isProductionEnv(env) || destructiveMigrationAllowed(env)) return;
  if (migration.direction === 'down') {
    throw new DestructiveMigrationError(migration.version, 'down', []);
  }
  const statements = findDestructiveStatements(migration.sql);
  if (statements.length > 0) {
    throw new DestructiveMigrationError(migration.version, 'up', statements);
  }
}
