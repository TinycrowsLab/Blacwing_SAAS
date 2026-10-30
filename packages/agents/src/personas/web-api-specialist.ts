import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';

import type { ORACLE_CATALOGUE } from './oracles.js';

/** Oracle types this persona binds candidates to (a subset of the shared catalogue). */
export const WEB_API_ORACLE_TYPES = [
  'reflected_marker',
  'status_diff',
  'out_of_band',
  'error_signature',
  'header_flag',
] as const satisfies readonly (typeof ORACLE_CATALOGUE)[number][];

/**
 * Native helpers a specialist may spawn (`CONTEXT_PACK §4`). They share the specialist's sandbox and
 * egress identity, so they take no tools of their own: they only craft and diff data the parent sends.
 */
export const WEB_API_HELPERS = [
  {
    name: 'payload-crafter',
    description:
      'Builds benign detection probes for one declared class from the test-case brief. Returns data only; sends nothing.',
    tierAlias: 'fast',
    allowedTools: [],
  },
  {
    name: 'response-differ',
    description:
      'Compares a probe response with its baseline and negative control and reports status, length, header and marker differences.',
    tierAlias: 'fast',
    allowedTools: [],
  },
] as const;

/**
 * The `web-api-specialist` persona (REGISTRY-010, CONTEXT_PACK §4.6, REFERENCES §8.1). Deep specialist for
 * web and API input-handling and configuration classes. It detects with benign probes, binds each
 * candidate to a declared oracle and a negative control, and submits it. The validator judges; the
 * persona never self-confirms. Tools, ceiling and oracles are data; enforcement is deterministic (PDP
 * hook, egress gateway, budgets, kill switch; §8.11).
 */
export const webApiSpecialistPersona = registerPersona({
  name: 'web-api-specialist',
  mandate:
    'Detect injection (CWE-89, CWE-79, WSTG-INPV-05/01/02), SSRF (CWE-918, WSTG-INPV-19, API7), XXE (CWE-611, ' +
    'WSTG-INPV-07), SSTI (CWE-1336, WSTG-INPV-18), path traversal (CWE-22, WSTG-ATHZ-01), CORS and headers ' +
    '(WSTG-CLNT-07, WSTG-CONF), GraphQL (WSTG-APIT), mass assignment (API3, CWE-915) and safe file-upload ' +
    'handling (WSTG-BUSL-09) using benign detection probes only, and submit each candidate bound to its oracle.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 80,
  maxBudgetUsdDefault: 10,
  allowedTools: [...EXPOSURE_MATRIX['web-api-specialist']],
  disallowedTools: ['WebFetch', 'WebSearch'],
  declaredOracleTypes: [...WEB_API_ORACLE_TYPES],
  inputs: ['test_case_brief', 'surface_model', 'prior_subtask_results'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: true,
  helpers: [...WEB_API_HELPERS],
  promptRef: { persona: 'web-api-specialist', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
