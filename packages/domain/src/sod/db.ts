import { ValidationError } from '@blackwing/errors';

/**
 * DB-level separation of duties (#352, §8.4): a generator, not a migration. AUTHZ-009 calls it for
 * `standing_authorisations` and `gate_decisions` from its own migration, so the rule holds even when service code
 * is skipped (direct writes). The generated SQL is plain PostgreSQL 16.
 */

/** Custom SQLSTATE raised by the generated trigger. AUTHZ-009 maps it to the `authz.sod.violation` audit event. */
export const SOD_SQLSTATE = 'SOD01';

/** Message prefix of every trigger raise, so logs and audit mapping can match `sod_violation`. */
export const SOD_RAISE_PREFIX = 'sod_violation';

/** The table and the two `user_id` columns a generated rule applies to. */
export interface SodTableSpec {
  /** Table name, lowercase snake_case. */
  readonly table: string;
  /** Column holding the requester's user id. */
  readonly requesterCol: string;
  /** Column holding the approver's user id. NULL means not decided yet and is allowed by the check. */
  readonly approverCol: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** Longest suffix any generated object adds to the shared base name (`_trg`). */
const LONGEST_SUFFIX = 4;
const PG_NAME_MAX = 63;

/** Validates every identifier before it is quoted into SQL. Anything else is refused (fail closed). */
function validated(spec: SodTableSpec): { table: string; req: string; appr: string; base: string } {
  for (const [label, value] of [
    ['table', spec.table],
    ['requesterCol', spec.requesterCol],
    ['approverCol', spec.approverCol],
  ] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new ValidationError(`invalid SQL identifier for ${label}: ${JSON.stringify(value)}`);
    }
  }
  if (spec.requesterCol === spec.approverCol) {
    throw new ValidationError('requesterCol and approverCol must be different columns');
  }
  const base = `sod_${spec.table}_${spec.requesterCol}_${spec.approverCol}`;
  if (base.length + LONGEST_SUFFIX > PG_NAME_MAX) {
    throw new ValidationError(`generated SoD object names exceed ${PG_NAME_MAX} characters`);
  }
  return {
    table: `"${spec.table}"`,
    req: `"${spec.requesterCol}"`,
    appr: `"${spec.approverCol}"`,
    base,
  };
}

/**
 * `ALTER TABLE ... ADD CONSTRAINT ... CHECK (requester <> approver)`. A NULL approver passes (undecided), a
 * NULL requester is refused by the trigger from {@link sodTrigger}.
 */
export function sodCheckConstraint(spec: SodTableSpec): string {
  const { table, req, appr, base } = validated(spec);
  return `ALTER TABLE ${table} ADD CONSTRAINT "${base}_ck" CHECK (${req} <> ${appr});`;
}

/**
 * A `BEFORE INSERT OR UPDATE` trigger that raises SQLSTATE {@link SOD_SQLSTATE} (message prefix
 * {@link SOD_RAISE_PREFIX}) when the requester is NULL or equals a non-NULL approver.
 * Idempotent: it replaces the function and drops the trigger before creating it.
 */
export function sodTrigger(spec: SodTableSpec): string {
  const { table, req, appr, base } = validated(spec);
  const fn = `"${base}_fn"`;
  const trg = `"${base}_trg"`;
  return [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $sod$`,
    'BEGIN',
    `  IF NEW.${req} IS NULL THEN`,
    `    RAISE EXCEPTION '${SOD_RAISE_PREFIX}: requester is null' USING ERRCODE = '${SOD_SQLSTATE}';`,
    '  END IF;',
    `  IF NEW.${appr} IS NOT NULL AND NEW.${req} = NEW.${appr} THEN`,
    `    RAISE EXCEPTION '${SOD_RAISE_PREFIX}: requester equals approver' USING ERRCODE = '${SOD_SQLSTATE}';`,
    '  END IF;',
    '  RETURN NEW;',
    'END;',
    '$sod$;',
    `DROP TRIGGER IF EXISTS ${trg} ON ${table};`,
    `CREATE TRIGGER ${trg} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
  ].join('\n');
}
