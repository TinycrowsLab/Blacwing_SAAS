import { registerPersona } from '../persona.js';

/**
 * The `orchestrator` persona (REGISTRY-010, REFERENCES §8.1 / §8.2, CONTEXT_PACK §4.6).
 *
 * Long-running delegation agent (orchestrator-worker). It only talks to the engagement MCP server:
 * subtasks are dispatched through `dispatch_subtask` to the Run Controller (a new sandbox per
 * specialist), never the native `Agent` tool, and it never touches a target. Tools, ceiling and
 * oracle are data; enforcement is deterministic (PDP hook, egress gateway, budgets; §8.11).
 */
const SERVER = 'mcp__blackwing_engagement__';

export const ORCHESTRATOR_ALLOWED_TOOLS = [
  'get_engagement_state',
  'list_open_subtasks',
  'dispatch_subtask',
  'get_subtask_result',
  'request_mentor_review',
  'mark_test_case_status',
  'request_scope_exception',
].map((t) => `${SERVER}${t}`);

export const orchestratorPersona = registerPersona({
  name: 'orchestrator',
  mandate:
    'Drive the approved run to completion: read the shared task listing, delegate open subtasks to the right specialist persona, track test-case status, request mentor review on stalls and decide completion. Never interacts with targets directly.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 200,
  maxBudgetUsdDefault: 25,
  allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
  disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Agent'],
  declaredOracleTypes: [],
  inputs: [
    'engagement_state',
    'open_subtasks',
    'subtask_results',
    'approved_envelope',
    'surface_model_summary',
  ],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'orchestrator', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
