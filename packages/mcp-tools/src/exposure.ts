/**
 * The per-persona tool-exposure matrix (MCP-015, #680, CONTEXT_PACK §4.3, §4.6, §8.11).
 *
 * This is the single source of truth for which tools each persona may call. `@blackwing/agents` builds each
 * persona's `allowedTools` from its row here, so the persona definitions cannot drift from the matrix. A row
 * lists exact `mcp__<server>__<tool>` names and built-ins; a `__*` entry is a prefix wildcard for an external
 * MCP server whose tool names are not enumerable offline (for example `mcp__playwright__*`).
 *
 * Every entry must have a class in {@link TOOL_EXPOSURE_CLASSES}. Adding a tool to a row without a class fails
 * the tests, and so does a target-reaching tool in a persona without target mandate.
 */

/** What a tool does, for the exposure rules. Read-only personas may expose `readOnly` tools only. */
export interface ToolExposureClass {
  /** The tool changes nothing (the `readOnlyHint` the planner and the PDP rely on). */
  readonly readOnly: boolean;
  /** The tool reaches a target or a target-facing channel (sandbox egress, OOB, browser, session login). */
  readonly reachesTarget: boolean;
}

/** Personas that may expose target-reaching tools (their CONTEXT_PACK §4.6 mandate is target interaction). */
export const TARGET_MANDATE_PERSONAS = [
  'active-recon',
  'session-setup',
  'web-api-specialist',
  'auth-logic-specialist',
  'infrastructure-specialist',
  'code-specialist',
  'exploit-developer',
] as const;

/** Personas whose mandate is read-only: every tool they expose must be `readOnly`. */
export const READ_ONLY_PERSONAS = [
  'planner',
  'sub-planner',
  'mentor',
  'reflector',
  'validator-assistant',
  'reporter',
  'remediation',
] as const;

const READ: ToolExposureClass = { readOnly: true, reachesTarget: false };
const WRITE: ToolExposureClass = { readOnly: false, reachesTarget: false };
const TARGET_READ: ToolExposureClass = { readOnly: true, reachesTarget: true };
const TARGET_WRITE: ToolExposureClass = { readOnly: false, reachesTarget: true };

/** Every entry that may appear in a matrix row, with its class. Wildcards are classed conservatively. */
export const TOOL_EXPOSURE_CLASSES: Readonly<Record<string, ToolExposureClass>> = {
  Bash: TARGET_WRITE,
  Read: READ,
  Grep: READ,
  Glob: READ,
  Write: WRITE,
  Edit: WRITE,
  mcp__blackwing__http_request: TARGET_WRITE,
  mcp__blackwing__tcp_probe: TARGET_WRITE,
  mcp__blackwing__dns_lookup: TARGET_READ,
  mcp__blackwing__write_surface: WRITE,
  mcp__blackwing__get_engagement_state: READ,
  mcp__blackwing__mark_test_case_status: WRITE,
  'mcp__playwright__*': TARGET_WRITE,
  mcp__blackwing_engagement__get_engagement_state: READ,
  mcp__blackwing_engagement__list_open_subtasks: READ,
  mcp__blackwing_engagement__get_subtask_result: READ,
  mcp__blackwing_engagement__dispatch_subtask: WRITE,
  mcp__blackwing_engagement__request_mentor_review: WRITE,
  mcp__blackwing_engagement__mark_test_case_status: WRITE,
  mcp__blackwing_engagement__request_scope_exception: WRITE,
  mcp__blackwing_surface__surface_query: READ,
  mcp__blackwing_surface__surface_upsert: WRITE,
  mcp__blackwing_testcases__test_case_library_read: READ,
  'mcp__blackwing_intel__*': READ,
  mcp__blackwing_target__http_request: TARGET_WRITE,
  mcp__blackwing_target__http_batch: TARGET_WRITE,
  mcp__blackwing_target__tcp_probe: TARGET_WRITE,
  mcp__blackwing_oob__oob_allocate: TARGET_WRITE,
  mcp__blackwing_oob__oob_check: TARGET_READ,
  'mcp__blackwing_oob__*': TARGET_WRITE,
  mcp__blackwing_session__use_role: TARGET_WRITE,
  mcp__blackwing_session__check_session: TARGET_READ,
  'mcp__blackwing_session__*': TARGET_WRITE,
  'mcp__blackwing_journal__*': WRITE,
  mcp__blackwing_journal__lessons_read: READ,
  mcp__blackwing_findings__submit_candidate: WRITE,
  mcp__blackwing_findings__attach_evidence: WRITE,
  mcp__blackwing_findings__candidate_read: READ,
  mcp__blackwing_findings__evidence_read: READ,
  mcp__blackwing_findings__finding_read: READ,
  mcp__blackwing_transcript__transcript_summary_read: READ,
  mcp__blackwing_source__source_read: READ,
};

/** The matrix. Keys are the persona roster (`PERSONA_NAMES` in `@blackwing/agents`). */
export const EXPOSURE_MATRIX = {
  orchestrator: [
    'mcp__blackwing_engagement__get_engagement_state',
    'mcp__blackwing_engagement__list_open_subtasks',
    'mcp__blackwing_engagement__dispatch_subtask',
    'mcp__blackwing_engagement__get_subtask_result',
    'mcp__blackwing_engagement__request_mentor_review',
    'mcp__blackwing_engagement__mark_test_case_status',
    'mcp__blackwing_engagement__request_scope_exception',
  ],
  planner: [
    'mcp__blackwing_surface__surface_query',
    'mcp__blackwing_testcases__test_case_library_read',
  ],
  'sub-planner': ['mcp__blackwing_surface__surface_query'],
  'passive-recon': ['mcp__blackwing_intel__*'],
  osint: ['mcp__blackwing_intel__*'],
  'active-recon': [
    'Bash',
    'mcp__blackwing__http_request',
    'mcp__blackwing__tcp_probe',
    'mcp__blackwing__dns_lookup',
    'mcp__playwright__*',
    'mcp__blackwing__write_surface',
    'mcp__blackwing__get_engagement_state',
    'mcp__blackwing__mark_test_case_status',
  ],
  'threat-intel': ['mcp__blackwing_intel__*'],
  'source-spec-ingestion': ['Read', 'Grep', 'Glob', 'mcp__blackwing_surface__surface_upsert'],
  'session-setup': ['mcp__blackwing_session__*', 'mcp__playwright__*'],
  'web-api-specialist': [
    'Bash',
    'mcp__blackwing_target__http_request',
    'mcp__blackwing_target__http_batch',
    'mcp__playwright__*',
    'mcp__blackwing_oob__oob_allocate',
    'mcp__blackwing_oob__oob_check',
    'mcp__blackwing_journal__*',
    'mcp__blackwing_findings__submit_candidate',
    'mcp__blackwing_findings__attach_evidence',
  ],
  'auth-logic-specialist': [
    'Bash',
    'mcp__blackwing_target__http_request',
    'mcp__blackwing_target__http_batch',
    'mcp__playwright__*',
    'mcp__blackwing_session__use_role',
    'mcp__blackwing_session__check_session',
    'mcp__blackwing_oob__*',
    'mcp__blackwing_journal__*',
    'mcp__blackwing_findings__submit_candidate',
    'mcp__blackwing_findings__attach_evidence',
  ],
  'infrastructure-specialist': [
    'Bash',
    'mcp__blackwing_target__tcp_probe',
    'mcp__blackwing_findings__submit_candidate',
    'mcp__blackwing_findings__attach_evidence',
  ],
  'code-specialist': [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'mcp__blackwing_target__http_request',
    'mcp__blackwing_findings__submit_candidate',
    'mcp__blackwing_findings__attach_evidence',
  ],
  'exploit-developer': [
    'Bash',
    'Write',
    'Edit',
    'mcp__blackwing_target__http_request',
    'mcp__blackwing_findings__attach_evidence',
  ],
  mentor: ['mcp__blackwing_transcript__transcript_summary_read'],
  reflector: [
    'mcp__blackwing_transcript__transcript_summary_read',
    'mcp__blackwing_journal__lessons_read',
  ],
  'validator-assistant': [
    'mcp__blackwing_findings__candidate_read',
    'mcp__blackwing_findings__evidence_read',
    'mcp__blackwing_testcases__test_case_library_read',
  ],
  reporter: ['mcp__blackwing_findings__finding_read', 'mcp__blackwing_findings__evidence_read'],
  remediation: [
    'mcp__blackwing_findings__finding_read',
    'mcp__blackwing_findings__evidence_read',
    'mcp__blackwing_source__source_read',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Returns the class of a matrix entry, or `undefined` when the entry is not classified (fails closed). */
export function exposureClassOf(tool: string): ToolExposureClass | undefined {
  return Object.hasOwn(TOOL_EXPOSURE_CLASSES, tool) ? TOOL_EXPOSURE_CLASSES[tool] : undefined;
}

/** Built-ins that reach the network outside the egress path. Never exposed (CONTEXT_PACK §4.5). */
const NETWORKED_BUILTINS: readonly string[] = ['WebFetch', 'WebSearch'];

/**
 * The exposure rules for one persona's tool list, as a list of violations (empty when the list is allowed).
 * Fails closed: an unclassified tool is a violation. A target-reaching tool needs target mandate, and a
 * read-only persona may expose only `readOnly` tools. The persona tests and the REGISTRY both call this rule.
 */
export function exposureViolations(persona: string, tools: readonly string[]): string[] {
  const violations: string[] = [];
  const targetMandate = (TARGET_MANDATE_PERSONAS as readonly string[]).includes(persona);
  const readOnlyMandate = (READ_ONLY_PERSONAS as readonly string[]).includes(persona);
  for (const tool of tools) {
    if (NETWORKED_BUILTINS.includes(tool)) {
      violations.push(`${tool} is a networked built-in and is never exposed`);
      continue;
    }
    const cls = exposureClassOf(tool);
    if (cls === undefined) {
      violations.push(`${tool} is not classified in the exposure matrix`);
      continue;
    }
    if (cls.reachesTarget && !targetMandate) {
      violations.push(`${tool} reaches a target, which ${persona} has no mandate for`);
    }
    if (readOnlyMandate && !cls.readOnly) {
      violations.push(
        `${tool} is not read-only, which read-only persona ${persona} may not expose`,
      );
    }
  }
  return violations;
}
