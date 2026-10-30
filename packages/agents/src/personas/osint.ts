import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';

/**
 * The `osint` persona (CONTEXT_PACK §4.6). Black box only: it is not scheduled for grey/white runs.
 * Passive class; reaches third parties only through the gateway intelligence allowlist.
 */
export const osintPersona = registerPersona({
  name: 'osint',
  mandate:
    'Map the organisation footprint, leaked-credential metadata (never credential use) and code-leak signals from third-party sources (WSTG-INFO). No account use and no login attempts.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX.osint],
  disallowedTools: ['Bash', 'WebFetch', 'WebSearch'],
  declaredOracleTypes: [],
  inputs: ['org_identifiers', 'domain_identifiers', 'scope_rules'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'osint', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
