import { z } from 'zod';

import { LIMITS } from './limits.js';
import { sha256HexSchema, uuidV7Schema } from './primitives.js';

/**
 * Contracts of one agent session inside a `bw-sandbox` container (RUNTIME-001, #463; CONTEXT_PACK §4.1, §7).
 *
 * The `SessionDescriptor` is the self-contained input the Run Controller hands to `apps/agent-runtime`. It
 * carries everything that crosses the sandbox boundary, so the runtime never reads the host environment for
 * run data. Credentials appear only by reference (`virtualKeyRef`), never as values (§8.7).
 */

const KIB = 1024;
const AGENT_BRIEF_MAX_KIB = 256;

/** Largest task brief in UTF-8 bytes; a larger brief is refused before any model call. */
export const AGENT_BRIEF_MAX_BYTES = AGENT_BRIEF_MAX_KIB * KIB;

/** The 19 personas of the Agent Registry (CONTEXT_PACK §4.6). Kept equal to `PERSONA_NAMES` in `@blackwing/agents`. */
export const AGENT_SESSION_PERSONAS = [
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
export const agentSessionPersonaSchema = z.enum(AGENT_SESSION_PERSONAS);
export type AgentSessionPersona = z.infer<typeof agentSessionPersonaSchema>;

/** Effort levels a persona may run at (CONTEXT_PACK §4.3). */
export const AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const agentEffortSchema = z.enum(AGENT_EFFORT_LEVELS);

/** Upper bounds on the step and budget ceilings, so a corrupted descriptor cannot lift them without limit. */
const MAX_TURNS_CEILING = 1000;
const MAX_BUDGET_USD_CEILING = 10_000;
const TOOL_PATTERNS_MAX = 200;
const TOOL_PATTERN_MAX = LIMITS.keyMax * 2;
const ABSOLUTE_PATH_MAX = LIMITS.filePathMax;
const BROKER_TOKEN_MAX = 4096;
const VIRTUAL_KEY_REF_MAX = 256;

const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'must be a semantic version (MAJOR.MINOR.PATCH)',
  );

/** A full model identifier, e.g. `claude-opus-5-5` or a provider-qualified ID. Aliases are not accepted. */
const modelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/, 'must be a full model identifier');

/** A tool pattern: an exact name, or one name with a single trailing `*`. A catch-all is never accepted. */
const toolPatternSchema = z
  .string()
  .min(1)
  .max(TOOL_PATTERN_MAX)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(__[A-Za-z0-9_]+)*(__\*|\*)?$/, 'must be a tool name or prefix*');

/** Scheme must be http or https. Credentials in the URL are refused: they would reach the logs. */
const httpUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(LIMITS.urlMax)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'must not carry credentials');

/** An absolute path inside the sandbox. Unicode is kept verbatim; NUL bytes are refused. */
const absolutePathSchema = z
  .string()
  .min(1)
  .max(ABSOLUTE_PATH_MAX)
  .regex(/^\//, 'must be an absolute path')
  .refine((value) => !value.includes('\u0000'), 'must not contain NUL bytes');

/** A run-scoped broker token: `bwrun_<payload>.<signature>`, one token with no whitespace. */
const brokerTokenSchema = z
  .string()
  .min(1)
  .max(BROKER_TOKEN_MAX)
  .regex(/^bwrun_\S+$/, 'must be a run-scoped broker token');

/** A virtual key reference (never the key). A raw `bwk_` key is refused so it cannot reach a descriptor. */
const virtualKeyRefSchema = z
  .string()
  .min(1)
  .max(VIRTUAL_KEY_REF_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'must be a virtual key reference')
  .refine((value) => !value.startsWith('bwk_'), 'must be a reference, not a key value');

/** The brief is UTF-8 text. Its byte size is checked by the runtime, which maps it to `AGENT_BRIEF_TOO_LARGE`. */
const briefSchema = z.string().min(1);

export const agentSessionDescriptorSchema = z.strictObject({
  runId: uuidV7Schema,
  sessionId: uuidV7Schema,
  tenantId: uuidV7Schema,
  persona: agentSessionPersonaSchema,
  personaVersion: semverSchema,
  promptSha256: sha256HexSchema,
  model: modelIdSchema,
  effort: agentEffortSchema,
  maxTurns: z.int().min(1).max(MAX_TURNS_CEILING),
  maxBudgetUsd: z.number().positive().max(MAX_BUDGET_USD_CEILING),
  allowedTools: z.array(toolPatternSchema).max(TOOL_PATTERNS_MAX),
  disallowedTools: z.array(toolPatternSchema).max(TOOL_PATTERNS_MAX),
  subtaskId: uuidV7Schema.optional(),
  testCaseId: uuidV7Schema.optional(),
  roleId: z.string().min(1).max(LIMITS.keyMax).optional(),
  brief: briefSchema,
  envelopeHash: sha256HexSchema,
  brokerBaseUrl: httpUrlSchema,
  brokerToken: brokerTokenSchema,
  modelGatewayBaseUrl: httpUrlSchema,
  virtualKeyRef: virtualKeyRefSchema,
  caBundlePath: absolutePathSchema,
  workspaceDir: absolutePathSchema,
  outputSchemaId: z.string().min(1).max(LIMITS.keyMax).optional(),
});
export type AgentSessionDescriptor = z.infer<typeof agentSessionDescriptorSchema>;

/**
 * Path segment of the broker route that records one finished session (`agent_sessions`, CONTEXT_PACK §7):
 * `POST /internal/broker/runs/{runId}/agent-sessions`. The Run Broker serves it when the session store lands.
 */
export const AGENT_SESSION_RECORD_SUFFIX = 'agent-sessions';

/**
 * The body a runtime sends once its session has finished. `sessionId` is the idempotency key: a duplicate
 * start of the same session writes one row (the broker dedupes on it).
 */
export const agentSessionRecordSchema = z.strictObject({
  sessionId: uuidV7Schema,
  persona: agentSessionPersonaSchema,
  personaVersion: semverSchema,
  promptSha256: sha256HexSchema,
  model: modelIdSchema,
  effort: agentEffortSchema,
  sdkVersion: z.string().min(1).max(LIMITS.keyMax),
  status: z.string().min(1).max(LIMITS.keyMax),
  numTurns: z.int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  modelUsage: z.record(z.string().min(1).max(LIMITS.keyMax), z.unknown()),
});
export type AgentSessionRecord = z.infer<typeof agentSessionRecordSchema>;
