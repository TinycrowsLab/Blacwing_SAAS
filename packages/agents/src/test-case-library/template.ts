import { z } from 'zod';

import {
  compatibleNegativeControlKinds,
  cweIdSchema,
  NEGATIVE_CONTROL_KINDS,
  ORACLE_SPEC_TYPES,
  requiresNegativeControl,
  RUN_MODES,
  runModeSchema,
  standardsRefsSchema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import type { PersonaName } from '../persona.js';

/**
 * Selectable classes only: a template never carries `destructive`, which never runs (§8.3). Kept as a literal
 * tuple so the schema and the counts narrow; a test pins it to `SELECTABLE_INTRUSIVENESS_CLASSES`.
 */
export const TEMPLATE_CLASSES = ['passive', 'active_safe', 'state_changing'] as const;

/**
 * Test-case template schema (PLANNER-002, #428, CONTEXT_PACK §4.6 / §7 / §8.9). A template is versioned data the
 * planner draws from: one per vulnerability class, carrying the standards mapping, a default declared oracle type,
 * a default negative control, a default budget profile and the specialist persona that owns the class.
 *
 * Templates hold identifiers and enum values only. There is no free-text field, so no payload, command or attack
 * step can be written into one (the schema is strict, and a test scans the shipped library against the denylist).
 * Every field reuses the PLANNER-001 definitions in `@blackwing/contracts` (intrusiveness, standards refs, CWE id,
 * oracle type, negative-control kind, run mode), so a template and a planned test case agree on what is valid.
 */

/** Budget profiles a template may name. PLANNER-005 resolves each one to a concrete `TestCaseBudget`. */
export const TEMPLATE_BUDGET_PROFILES = ['small', 'medium', 'large'] as const;
export type TemplateBudgetProfile = (typeof TEMPLATE_BUDGET_PROFILES)[number];

/** The specialist personas a template may route to. Every other persona is planned by the orchestrator, not a template. */
export const SPECIALIST_PERSONAS = [
  'web-api-specialist',
  'auth-logic-specialist',
  'infrastructure-specialist',
  'code-specialist',
] as const satisfies readonly PersonaName[];

/** The WSTG v4.2 top-level categories every library version must cover (REFERENCES §6). */
export const WSTG_TOP_CATEGORIES = [
  'INFO',
  'CONF',
  'IDNT',
  'ATHN',
  'ATHZ',
  'SESS',
  'INPV',
  'ERRH',
  'CRYP',
  'BUSL',
  'CLNT',
  'APIT',
] as const;

/** The OWASP API Security Top 10 2023 items every library version must cover (REFERENCES §6). */
export const API_TOP10_IDS = [
  'API1',
  'API2',
  'API3',
  'API4',
  'API5',
  'API6',
  'API7',
  'API8',
  'API9',
  'API10',
] as const;

/** Stable machine code a failing library validation carries (registered in `@blackwing/errors`). */
export class TestCaseLibraryError extends AppError {
  /** One `path: message` line per problem. Values are never echoed: templates are data under review. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      'TEST_CASE_LIBRARY_INVALID',
      `test-case template library is invalid (${String(issues.length)} problem(s))`,
    );
    this.name = 'TestCaseLibraryError';
    this.issues = Object.freeze([...issues]);
  }
}

const templateIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,63}$/, 'must be a lowercase kebab-case id');

/** A WSTG v4.2 subtest id whose category is one of the top-level categories this library covers. */
const wstgRefSchema = z
  .string()
  .regex(
    new RegExp(`^WSTG-(${WSTG_TOP_CATEGORIES.join('|')})-[0-9]{2}$`),
    'must be a WSTG v4.2 subtest id in a known category',
  );

const uniqueItems = (items: readonly string[]): boolean => new Set(items).size === items.length;

/** Upper bounds for the standards-ref and CWE lists of one template (kept small on purpose: a template names a class). */
const MAX_STANDARDS_REFS = 4;
const MAX_CWE_CANDIDATES = 8;

/** One template. Strict: an unknown field (such as a payload) is rejected, not ignored. */
export const templateSchema = z
  .strictObject({
    templateId: templateIdSchema,
    class: z.enum(TEMPLATE_CLASSES),
    defaultOracleType: z.enum(ORACLE_SPEC_TYPES),
    /** `null` only for a `passive` template, which needs no control (requiresNegativeControl). */
    defaultNegativeControl: z.enum(NEGATIVE_CONTROL_KINDS).nullable(),
    owaspRefs: standardsRefsSchema.shape.owasp.min(1).max(MAX_STANDARDS_REFS).readonly(),
    wstgRefs: z.array(wstgRefSchema).min(1).max(MAX_STANDARDS_REFS).readonly(),
    asvsRefs: standardsRefsSchema.shape.asvs.min(1).max(MAX_STANDARDS_REFS).readonly(),
    cweCandidates: z.array(cweIdSchema).min(1).max(MAX_CWE_CANDIDATES).readonly(),
    applicableModes: z.array(runModeSchema).min(1).max(RUN_MODES.length).readonly(),
    defaultBudgetProfile: z.enum(TEMPLATE_BUDGET_PROFILES),
    specialistPersona: z.enum(SPECIALIST_PERSONAS),
  })
  .superRefine((template, ctx) => {
    if (!uniqueItems(template.applicableModes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['applicableModes'],
        message: 'must not repeat a mode',
      });
    }
    for (const key of ['owaspRefs', 'wstgRefs', 'asvsRefs', 'cweCandidates'] as const) {
      if (!uniqueItems(template[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must not repeat an id' });
      }
    }
    const control = template.defaultNegativeControl;
    if (control === null) {
      if (requiresNegativeControl({ class: template.class })) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultNegativeControl'],
          message:
            'NEGATIVE_CONTROL_MISSING: a non-passive template needs a default negative control',
        });
      }
    } else if (!compatibleNegativeControlKinds(template.defaultOracleType)?.includes(control)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultNegativeControl'],
        message: 'NEGATIVE_CONTROL_ORACLE_MISMATCH: the control does not suit the default oracle',
      });
    }
  });

/** One library entry. Field-by-field the same definitions the planned test case uses (PLANNER-001). */
export type Template = z.infer<typeof templateSchema>;

/** Run modes a template can apply to (black, grey, white). */
export type TemplateMode = (typeof RUN_MODES)[number];

/**
 * Validates every template of one library version. Returns the parsed templates, or throws
 * {@link TestCaseLibraryError} listing every problem, so a broken library fails the build (CI) and never a run.
 * Duplicate `templateId`s and an empty library are problems too.
 */
export function validateTemplateLibrary(templates: readonly unknown[]): readonly Template[] {
  const issues: string[] = [];
  if (templates.length === 0) issues.push('library: must contain at least one template');
  const seen = new Set<string>();
  const parsedTemplates: Template[] = [];
  templates.forEach((raw, index) => {
    const parsed = templateSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.');
        issues.push(`[${String(index)}]${path === '' ? '' : `.${path}`}: ${issue.message}`);
      }
      return;
    }
    if (seen.has(parsed.data.templateId)) {
      issues.push(`[${String(index)}].templateId: duplicate templateId`);
    }
    seen.add(parsed.data.templateId);
    parsedTemplates.push(parsed.data);
  });
  if (issues.length > 0) throw new TestCaseLibraryError(issues);
  return parsedTemplates;
}

/** Templates that apply to a run mode. A source-only (white) template is excluded for black box. */
export function templatesForMode(
  templates: readonly Template[],
  mode: TemplateMode,
): readonly Template[] {
  return templates.filter((t) => t.applicableModes.includes(mode));
}

/** Template count per class, for the `plan_templates_total{class}` coverage metric. Every selectable class is present. */
export function templateCountsByClass(
  templates: readonly Template[],
): Readonly<Record<Template['class'], number>> {
  const counts: Record<Template['class'], number> = {
    passive: 0,
    active_safe: 0,
    state_changing: 0,
  };
  for (const t of templates) counts[t.class] += 1;
  return Object.freeze(counts);
}
