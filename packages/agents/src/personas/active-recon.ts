import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';

/** `submit_candidate` is the finding-submission tool; recon raises no findings. */
export const SUBMIT_CANDIDATE_TOOL = 'mcp__blackwing__submit_candidate';

/**
 * The `active-recon` persona (CONTEXT_PACK §4.6). Black and grey box; confirms the supplied surface in
 * grey/white box. Active-safe class only; every network path goes through the egress gateway, which is
 * the primary budget and scope guard (the session `maxBudgetUsd` is secondary).
 */
export const activeReconPersona = registerPersona({
  name: 'active-recon',
  mandate:
    'Actively discover and confirm in-scope hosts, services, HTTP endpoints and parameters using only ' +
    'active_safe traffic, writing them to the surface model. Confirmation of vulnerabilities belongs to ' +
    'the specialists and the Validator.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 60,
  maxBudgetUsdDefault: 5,
  allowedTools: [...EXPOSURE_MATRIX['active-recon']],
  disallowedTools: ['WebFetch', 'WebSearch', SUBMIT_CANDIDATE_TOOL],
  declaredOracleTypes: [],
  inputs: ['run_envelope', 'mode', 'input_manifest', 'passive_results', 'test_case_budgets'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: false,
  promptRef: { persona: 'active-recon', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
