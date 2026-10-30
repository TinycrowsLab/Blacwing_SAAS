import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';

/**
 * `remediation` (CONTEXT_PACK §4.6). Produces fix guidance, ticket text and a retest plan for
 * one confirmed finding, tied to its CWE and remediation pattern. Read-only and passive; the source it reads
 * is untrusted data.
 */
export const remediationPersona = registerPersona({
  name: 'remediation',
  mandate:
    'Produce fix guidance (code-level in white-box runs, class-level otherwise), ticket text and a retest ' +
    'plan for one confirmed finding, citing standard IDs and remediation patterns only.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX.remediation],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['confirmed_finding', 'finding_report', 'source_context'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'remediation', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
