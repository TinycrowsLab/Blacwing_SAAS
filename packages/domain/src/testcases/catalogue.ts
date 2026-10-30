import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  authorisableIntrusivenessSchema,
  type AuthorisableIntrusiveness,
  DEFAULT_REQUEST_BUDGETS,
  labelSchema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import { isKnownApiTop10, isKnownCwe, isKnownOwaspTop10, isKnownWstg } from './standards.js';

import type { SurfaceNode } from '../surface/write.js';

/**
 * Test-case catalogue framework (WEBAPI-001, #682): the schema every catalogue entry must satisfy and the
 * build-time checks that keep a catalogue current. A catalogue describes WHAT to detect and HOW to verify
 * it (standard ids, declared oracle, negative control, intrusiveness), never how to exploit: the entry
 * schema is strict and has no free-form payload field.
 */

/**
 * Oracle types a catalogue entry may declare: the four response-inspection types (PLAN-002, #392) and the
 * four blind/stateful ones (PLAN-003, #393). The oracle schema itself is owned by those issues; this list
 * is the shared key set until they land.
 */
export const ORACLE_TYPES = [
  'marker',
  'status_diff',
  'error_signature',
  'header_cookie_flag',
  'timing_baseline',
  'out_of_band',
  'access_matrix',
  'file_read_marker',
  'config_signature',
  'version_cve',
] as const;
export type OracleType = (typeof ORACLE_TYPES)[number];

/** How a negative control is constructed (F16): the control must NOT trip the entry's oracle. */
export const NEGATIVE_CONTROL_STRATEGIES = [
  'benign_value',
  'unmodified_request',
  'unbound_interaction',
  'compliant_variant',
] as const;
export type NegativeControlStrategy = (typeof NEGATIVE_CONTROL_STRATEGIES)[number];

/** A catalogue that fails the build-time checks (schema, unknown standard id, duplicate class id). */
export class CatalogueError extends AppError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, { detail: message });
    this.name = 'CatalogueError';
  }
}

const unique = <T extends z.ZodType>(item: T): z.ZodArray<T> =>
  z.array(item).refine((values) => new Set(values).size === values.length, 'must not repeat ids');

const CONTROL_DESCRIPTION_MAX = 300;

/** Per-class budget hint; never above the shipped default of the entry's intrusiveness class. */
const budgetHintSchema = z.strictObject({
  maxRequests: z.int().positive(),
  maxRps: z.number().positive(),
});

const catalogueEntrySchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'must be a dotted class id'),
    title: labelSchema,
    wstg: unique(z.string().regex(/^WSTG-[A-Z]{4}-[0-9]{2}$/)),
    cwe: unique(z.string().regex(/^CWE-[1-9][0-9]{0,4}$/)).min(1),
    owasp: unique(z.string().regex(/^A(0[1-9]|10)$/)),
    apiTop10: unique(z.string().regex(/^API([1-9]|10)$/)).optional(),
    oracleType: z.enum(ORACLE_TYPES),
    negativeControlTemplate: z.strictObject({
      strategy: z.enum(NEGATIVE_CONTROL_STRATEGIES),
      oracleType: z.enum(ORACLE_TYPES),
      description: z.string().min(1).max(CONTROL_DESCRIPTION_MAX),
    }),
    // `destructive` is never catalogued (§8.3); the authorisable subset has no such member.
    intrusiveness: authorisableIntrusivenessSchema,
    budgetHint: budgetHintSchema,
    /** Set on a class that confirms a credential by reference (§8.7): the credential is never in the entry. */
    requiresReferenceCredentials: z.boolean().optional(),
    appliesTo: z.custom<(node: SurfaceNode) => boolean>(
      (value) => typeof value === 'function',
      'must be a predicate over a surface node',
    ),
  })
  .superRefine((entry, ctx) => {
    const unknown = (
      path: string,
      ids: readonly string[],
      known: (id: string) => boolean,
    ): void => {
      for (const id of ids.filter((candidate) => !known(candidate))) {
        ctx.addIssue({ code: 'custom', path: [path], message: `unknown or retired id ${id}` });
      }
    };
    unknown('wstg', entry.wstg, isKnownWstg);
    unknown('cwe', entry.cwe, isKnownCwe);
    unknown('owasp', entry.owasp, isKnownOwaspTop10);
    unknown('apiTop10', entry.apiTop10 ?? [], isKnownApiTop10);
    if (entry.owasp.length + (entry.apiTop10?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['owasp'], message: 'needs an OWASP category' });
    }
    const defaults = DEFAULT_REQUEST_BUDGETS[entry.intrusiveness];
    if (
      entry.budgetHint.maxRequests > defaults.maxRequests ||
      entry.budgetHint.maxRps > defaults.maxRps
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgetHint'],
        message: `above the ${entry.intrusiveness} default budget`,
      });
    }
    if (entry.budgetHint.maxRps > entry.budgetHint.maxRequests) {
      ctx.addIssue({ code: 'custom', path: ['budgetHint'], message: 'maxRps above maxRequests' });
    }
  });

/** One catalogued test class. */
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

/** A validated, frozen catalogue with its pinned version and content digest (§8.9). */
export interface Catalogue {
  readonly version: string;
  /** SHA-256 over the canonical entry data (predicates excluded); changes whenever an entry does. */
  readonly digest: string;
  readonly entries: readonly CatalogueEntry[];
}

/**
 * Validates `entries` and freezes them into a catalogue. Throws {@link CatalogueError} on a schema
 * violation, an unknown or retired standard id, an unsupported class (`destructive`) or a duplicate class id,
 * so a stale catalogue fails when the module loads, in the build and in every test.
 */
export function defineCatalogue(version: string, entries: readonly unknown[]): Catalogue {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new CatalogueError(`catalogue version ${version} is not semver`);
  }
  const seen = new Set<string>();
  const parsed = entries.map((raw, index) => {
    const result = catalogueEntrySchema.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = [`entry ${index}`, ...(issue?.path ?? [])].join('.');
      throw new CatalogueError(`${where}: ${issue?.message ?? 'invalid'}`);
    }
    if (seen.has(result.data.id)) {
      throw new CatalogueError(`duplicate class id ${result.data.id}`);
    }
    seen.add(result.data.id);
    return Object.freeze(result.data);
  });
  const digest = createHash('sha256')
    .update(JSON.stringify([version, ...[...parsed].sort((a, b) => a.id.localeCompare(b.id))]))
    .digest('hex');
  return Object.freeze({ version, digest, entries: Object.freeze(parsed) });
}

/** The classes whose predicate accepts `node`. An entry that applies to nothing is simply not selected. */
export function selectApplicable(
  catalogue: Catalogue,
  node: SurfaceNode,
): readonly CatalogueEntry[] {
  return catalogue.entries.filter((entry) => entry.appliesTo(node));
}

/** Samples of a `*_entries_total{class}` gauge: entry count per intrusiveness class, emitted at load. */
export function entryCountsByClass(catalogue: Catalogue): readonly {
  readonly labels: { readonly class: AuthorisableIntrusiveness };
  readonly value: number;
}[] {
  return authorisableIntrusivenessSchema.options.map((cls) => ({
    labels: { class: cls },
    value: catalogue.entries.filter((entry) => entry.intrusiveness === cls).length,
  }));
}
