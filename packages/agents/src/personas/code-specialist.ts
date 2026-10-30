import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';

/**
 * The `code-specialist` persona (CONTEXT_PACK §4.6, REFERENCES §8.1). Deep white-box specialist: it traces
 * sources to sinks in the read-only mounted source, then proves each lead at runtime against the
 * mapped endpoint. Exposed secrets are flagged and never used (§8.7). Tools, ceiling and oracle are
 * data; enforcement is deterministic (§8.11).
 */
export const codeSpecialistPersona = registerPersona({
  name: 'code-specialist',
  mandate:
    'White-box review of the mounted source: trace untrusted inputs to dangerous sinks (CWE-89, CWE-78, ' +
    'CWE-22, CWE-79, CWE-918), flag exposed secrets (CWE-798) and assess dependency risk (GHSA, OSV). ' +
    'Every source-traced lead must be proven at runtime against the mapped endpoint, with a negative ' +
    'control, before it is submitted. Never judge a finding and never use a secret you find.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 80,
  maxBudgetUsdDefault: 10,
  allowedTools: [...EXPOSURE_MATRIX['code-specialist']],
  disallowedTools: ['WebFetch', 'WebSearch'],
  declaredOracleTypes: ['reflected_marker', 'file_read', 'status_diff'],
  inputs: ['mounted_source', 'source_endpoint_map', 'test_case_brief'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: true,
  promptRef: { persona: 'code-specialist', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
