import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';

/**
 * The `passive-recon` persona (CONTEXT_PACK §4.6). Black box only: it is not scheduled for grey/white runs.
 * Passive class; reaches third parties only through the gateway intelligence allowlist.
 */
export const passiveReconPersona = registerPersona({
  name: 'passive-recon',
  mandate:
    'Build surface context from third-party sources (DNS, certificate transparency, web archives, technology fingerprint) without touching the target (WSTG-INFO).',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX['passive-recon']],
  disallowedTools: ['Bash', 'WebFetch', 'WebSearch'],
  declaredOracleTypes: [],
  inputs: ['asset_identifiers', 'scope_rules'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'passive-recon', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
