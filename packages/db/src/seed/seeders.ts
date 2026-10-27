// The named steps of `pnpm db:seed` (DEVENV-011, #75). The `tenant` step (the tenant and its users) is the
// platform anchor and always runs, because every other step needs the tenant id it creates. The tenant-scoped
// steps write their own tables: `--only` picks which of them run, and a step whose tables are not migrated yet
// (or whose dependency is skipped) is skipped with `seed.skipped` instead of failing the run. Pure: no IO.

import { ValidationError } from '@blackwing/errors';

/** A tenant-scoped step: the tables it writes, and the steps whose rows it needs (an asset before its credentials). */
interface SeedStep {
  readonly name: string;
  readonly tables: readonly string[];
  readonly dependsOn: readonly string[];
}

/** The platform anchor. It is never skipped by `--only` and never by a missing table (it fails fast instead). */
const PLATFORM_STEP = 'tenant';

/** The tenant-scoped steps, in the order they run. */
const SEED_STEPS: readonly SeedStep[] = Object.freeze([
  { name: 'memberships', tables: ['memberships'], dependsOn: [] },
  { name: 'assets', tables: ['assets'], dependsOn: [] },
  { name: 'credentials', tables: ['asset_credentials'], dependsOn: ['assets'] },
  { name: 'standing-authorisations', tables: ['standing_authorisations'], dependsOn: ['assets'] },
  { name: 'role-matrices', tables: ['role_matrices'], dependsOn: ['assets'] },
]);

/** Every step name `--only` accepts. */
export const SEED_STEP_NAMES: readonly string[] = Object.freeze([
  PLATFORM_STEP,
  ...SEED_STEPS.map((step) => step.name),
]);

/**
 * Parses the value of `--only=a,b`. Undefined (flag absent) means every step. Empty or unknown names are
 * refused before anything is written, and the message lists the valid names.
 */
export function parseOnly(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const names = [
    ...new Set(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    ),
  ];
  const valid = SEED_STEP_NAMES.join(', ');
  if (names.length === 0) {
    throw new ValidationError(`--only needs at least one step name (one of: ${valid})`);
  }
  const unknown = names.filter((name) => !SEED_STEP_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new ValidationError(`unknown --only step(s): ${unknown.join(', ')} (one of: ${valid})`);
  }
  return names;
}

/** What this run does: the steps it writes, and the steps it skips with the reason. */
export interface SeedSelection {
  readonly run: readonly string[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Decides which tenant-scoped steps run. `problems` maps a table to the schema problems found for it (a
 * missing table or column). A selected step that writes such a table is skipped, and so is a selected step
 * whose dependency cannot run. A step left out by `only` is never reported as skipped: it simply does not run.
 */
export function selectSeeders(input: {
  readonly only: readonly string[] | undefined;
  readonly problems: ReadonlyMap<string, readonly string[]>;
}): SeedSelection {
  const selected = (name: string): boolean => input.only === undefined || input.only.includes(name);
  const unavailable = new Set<string>();
  const run: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const step of SEED_STEPS) {
    const missing = step.tables.flatMap((table) => input.problems.get(table) ?? []);
    const blockedBy = step.dependsOn.filter((dependency) => unavailable.has(dependency));
    if (missing.length > 0 || blockedBy.length > 0) {
      unavailable.add(step.name);
      if (selected(step.name)) {
        const reason =
          missing.length > 0
            ? missing.join('; ')
            : `depends on skipped step ${blockedBy.join(', ')}`;
        skipped.push({ name: step.name, reason });
      }
      continue;
    }
    if (selected(step.name)) run.push(step.name);
  }
  return { run, skipped };
}
