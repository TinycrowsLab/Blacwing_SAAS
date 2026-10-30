import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { ORACLE_CATALOGUE } from './oracles.js';

/** Surface-model read tool, exactly as the surface MCP server names it (`mcp__<server>__<tool>`). */
export const SURFACE_QUERY_TOOL = 'mcp__blackwing_surface__surface_query';
/** Test-case library read tool. */
export const TEST_CASE_LIBRARY_READ_TOOL = 'mcp__blackwing_testcases__test_case_library_read';

/** Tools neither planning persona may use: shell, networked built-ins, native subagents, target tools. */
export const PLANNING_DISALLOWED_TOOLS = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'mcp__blackwing__http_request',
  'mcp__blackwing__tcp_probe',
];

/**
 * `planner` (REGISTRY-010, REFERENCES §8.1). Plan-and-execute: surface model to proposed test cases with
 * a declared oracle each. Read-only; the ceiling is data, the PDP hook and gateway enforce it.
 */
export const plannerPersona = registerPersona({
  name: 'planner',
  mandate:
    'Convert the surface model into proposed test_cases. Each carries an intrusiveness class, a request ' +
    'budget, a declared validation oracle, OWASP/WSTG/ASVS references, and target endpoints and roles. ' +
    'Cite standard IDs only; never write payloads. Design oracles; never run them.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 40,
  maxBudgetUsdDefault: 5,
  allowedTools: [...EXPOSURE_MATRIX.planner],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [...ORACLE_CATALOGUE],
  inputs: ['surface_model', 'recon_summary', 'test_case_library', 'run_envelope'],
  intrusivenessCeiling: 'state_changing',
  requiresSubmission: false,
  structuredOutputSchemaId: 'plan.v1',
  promptRef: { persona: 'planner', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
