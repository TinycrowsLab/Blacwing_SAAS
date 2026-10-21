import { z } from 'zod';

import { INTRUSIVENESS_CLASSES, oracleSchema } from '@blackwing/contracts';
import { AppError, type ErrorCode } from '@blackwing/errors';

/**
 * The persona-definition schema (REGISTRY-001, CONTEXT_PACK §4.6 / §8.11).
 *
 * A persona's tools, effort and intrusiveness ceiling are DATA that RUNTIME enforces; this schema is
 * the contract RUNTIME trusts, so it is strict. Networked built-ins are never allowed (§4.5): the
 * model reaches the network only through Blackwing tools behind the egress gateway.
 */

/** The fixed roster of 19 personas (§4.6). The one place the names are declared. */
export const PERSONA_NAMES = [
  'orchestrator',
  'planner',
  'sub-planner',
  'passive-recon',
  'osint',
  'active-recon',
  'threat-intel',
  'source-spec-ingestion',
  'session-setup',
  'web-api-specialist',
  'auth-logic-specialist',
  'infrastructure-specialist',
  'code-specialist',
  'exploit-developer',
  'mentor',
  'reflector',
  'validator-assistant',
  'reporter',
  'remediation',
] as const;

export type PersonaName = (typeof PERSONA_NAMES)[number];

/** Model tier aliases; resolved per tenant provider and pinned per run (F37). */
export const TIER_ALIASES = ['deep', 'standard', 'fast'] as const;
export type TierAlias = (typeof TIER_ALIASES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Ceilings a persona may declare. `destructive` is deliberately absent (§8.3). */
export const PERSONA_INTRUSIVENESS_CEILINGS = INTRUSIVENESS_CLASSES.filter(
  (c): c is Exclude<(typeof INTRUSIVENESS_CLASSES)[number], 'destructive'> => c !== 'destructive',
);

/** Built-ins that reach the network outside the egress path; always disallowed (§4.5). */
export const FORBIDDEN_BUILTIN_TOOLS = ['WebFetch', 'WebSearch'] as const;

/** Failure of persona validation or lookup. Carries a registered `@blackwing/errors` code. */
export class PersonaError extends AppError {
  constructor(code: Extract<ErrorCode, `PERSONA_${string}`>, message: string, cause?: unknown) {
    super(code, message, cause === undefined ? {} : { cause });
    this.name = 'PersonaError';
  }
}

/** Upper bounds that keep a definition small and reviewable. */
const LIMIT = {
  name: 128,
  list: 256,
  text: 1000,
  mandate: 4000,
  big: 10_000,
  inputs: 64,
  helpers: 16,
  echo: 80,
} as const;

const toolName = z.string().trim().min(1).max(LIMIT.name);

/** Normalises a tool list: trimmed, de-duplicated, order preserved. */
const toolList = z
  .array(toolName)
  .max(LIMIT.list)
  .transform((tools) => [...new Set(tools)]);

const oracleType = oracleSchema.shape.type;
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a semver (x.y.z)');

/** A native subagent (helper) a persona may spawn. Its tools obey the same forbidden-tool rule. */
export const helperSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  description: z.string().trim().min(1).max(LIMIT.text),
  tierAlias: z.enum(TIER_ALIASES),
  allowedTools: toolList,
});
export type PersonaHelper = z.infer<typeof helperSchema>;

const personaShape = z.strictObject({
  name: z.string(),
  mandate: z.string().trim().min(1).max(LIMIT.mandate),
  tierAlias: z.enum(TIER_ALIASES),
  effort: z.enum(EFFORT_LEVELS),
  maxTurns: z.number().int().min(1).max(LIMIT.big),
  maxBudgetUsdDefault: z.number().positive().max(LIMIT.big),
  allowedTools: toolList,
  disallowedTools: toolList,
  declaredOracleTypes: z
    .array(oracleType)
    .max(LIMIT.list)
    .transform((t) => [...new Set(t)]),
  inputs: z
    .array(z.string().trim().min(1).max(LIMIT.name))
    .max(LIMIT.inputs)
    .transform((t) => [...new Set(t)]),
  intrusivenessCeiling: z.enum(PERSONA_INTRUSIVENESS_CEILINGS),
  requiresSubmission: z.boolean(),
  structuredOutputSchemaId: z.string().trim().min(1).max(LIMIT.name).optional(),
  helpers: z.array(helperSchema).max(LIMIT.helpers).optional(),
  promptRef: z.strictObject({ persona: z.enum(PERSONA_NAMES), version: semver }),
  guardrails: z.strictObject({
    scopeEnforced: z.boolean(),
    treatToolOutputAsUntrusted: z.boolean(),
  }),
});

const forbidden = new Set<string>(FORBIDDEN_BUILTIN_TOOLS);

/** Strict persona-definition schema (shape, roster membership and the forbidden-tool rules). */
export const personaDefinitionSchema = personaShape
  .superRefine((p, ctx) => {
    if (!(PERSONA_NAMES as readonly string[]).includes(p.name)) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'PERSONA_UNKNOWN' });
    }
    if (p.promptRef.persona !== p.name) {
      ctx.addIssue({ code: 'custom', path: ['promptRef', 'persona'], message: 'must equal name' });
    }
    for (const t of FORBIDDEN_BUILTIN_TOOLS) {
      if (!p.disallowedTools.includes(t)) {
        ctx.addIssue({
          code: 'custom',
          path: ['disallowedTools'],
          message: `PERSONA_FORBIDDEN_TOOL: disallowedTools must include ${t}`,
        });
      }
    }
    const lists: [string, readonly string[]][] = [
      ['allowedTools', p.allowedTools],
      ...(p.helpers ?? []).map((h, i): [string, readonly string[]] => [
        `helpers.${String(i)}.allowedTools`,
        h.allowedTools,
      ]),
    ];
    for (const [path, tools] of lists) {
      if (tools.some((t) => forbidden.has(t))) {
        ctx.addIssue({
          code: 'custom',
          path: path.split('.'),
          message: 'PERSONA_FORBIDDEN_TOOL: networked built-ins are never allowed',
        });
      }
    }
    const overlap = p.allowedTools.filter((t) => p.disallowedTools.includes(t));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedTools'],
        message: `tools both allowed and disallowed: ${overlap.join(', ')}`,
      });
    }
  })
  .transform((p) => ({ ...p, name: p.name as PersonaName }));

export type PersonaDefinition = z.output<typeof personaDefinitionSchema>;

/** Maps the first Zod issue to a stable persona error code. */
function codeFor(error: z.ZodError): Extract<ErrorCode, `PERSONA_${string}`> {
  const messages = error.issues.map((i) => i.message);
  if (messages.some((m) => m.startsWith('PERSONA_FORBIDDEN_TOOL'))) return 'PERSONA_FORBIDDEN_TOOL';
  if (messages.includes('PERSONA_UNKNOWN')) return 'PERSONA_UNKNOWN';
  return 'PERSONA_INVALID';
}

/** Validates an untrusted definition. Throws {@link PersonaError}; never returns a partial result. */
export function parsePersonaDefinition(input: unknown): PersonaDefinition {
  const result = personaDefinitionSchema.safeParse(input);
  if (result.success) return result.data;
  const code = codeFor(result.error);
  throw new PersonaError(
    code,
    `${code}: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    result.error,
  );
}

/** Type guard for the fixed roster. */
export function isPersonaName(value: unknown): value is PersonaName {
  return typeof value === 'string' && (PERSONA_NAMES as readonly string[]).includes(value);
}

const REGISTERED = new Map<PersonaName, PersonaDefinition>();

/**
 * Registers a persona definition (validated). The definitions themselves land in REGISTRY-010..021,
 * each calling this from `personas/<name>.ts`; the registry is data, never mutated at runtime by input.
 */
export function registerPersona(input: unknown): PersonaDefinition {
  const def = parsePersonaDefinition(input);
  REGISTERED.set(def.name, def);
  return def;
}

/** Returns the validated definition for `name`. Unknown names throw `PERSONA_UNKNOWN`. */
export function loadPersona(name: string): PersonaDefinition {
  if (!isPersonaName(name)) {
    throw new PersonaError(
      'PERSONA_UNKNOWN',
      `PERSONA_UNKNOWN: ${JSON.stringify(name).slice(0, LIMIT.echo)}`,
    );
  }
  const def = REGISTERED.get(name);
  if (def === undefined) {
    throw new PersonaError('PERSONA_NOT_DEFINED', `PERSONA_NOT_DEFINED: ${name}`);
  }
  return def;
}
