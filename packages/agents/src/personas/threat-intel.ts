import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';

/**
 * The `threat-intel` persona (CONTEXT_PACK §4.6). Runs in every mode. Passive class: it enriches detected
 * components with NVD CVE, CISA KEV, FIRST EPSS and OSV/GHSA data for prioritisation (OWASP A06). This is
 * enrichment, not confirmation, so it declares no oracle and never submits a candidate.
 */
export const threatIntelPersona = registerPersona({
  name: 'threat-intel',
  mandate:
    'Enrich detected technologies and components with vulnerability intelligence (NVD CVE, CISA KEV, FIRST EPSS, OSV.dev and GHSA) to prioritise known-vulnerable versions (OWASP A06:2021), mapped to CWE. Never confirm a vulnerability and never guess a CVE.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX['threat-intel']],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['surface_components', 'detected_versions'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'threat-intel', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
