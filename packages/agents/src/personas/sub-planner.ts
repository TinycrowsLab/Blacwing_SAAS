import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { ORACLE_CATALOGUE } from './oracles.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';

/**
 * `sub-planner` (REGISTRY-011, REFERENCES §8.1). Breaks an approved test case into self-contained subtask
 * briefs (§8.2). It inherits the test case's oracle and declares none of its own; read-only.
 */
export const subPlannerPersona = registerPersona({
  name: 'sub-planner',
  mandate:
    'Break one approved test case into self-contained subtask briefs: target endpoints, role, ' +
    'intrusiveness, the inherited oracle, a negative control, a budget and WSTG/CWE IDs. Never exceed ' +
    'the approved envelope and never invent a new oracle.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 20,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX['sub-planner']],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [...ORACLE_CATALOGUE],
  inputs: ['approved_test_case', 'run_envelope'],
  intrusivenessCeiling: 'state_changing',
  requiresSubmission: false,
  structuredOutputSchemaId: 'subtasks.v1',
  promptRef: { persona: 'sub-planner', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
