import { registerPersona } from '../persona.js';

/**
 * The `infrastructure-specialist` persona (CONTEXT_PACK §4.6, REFERENCES §8.1). Standard-tier specialist
 * for network services, TLS and configuration, exposed admin interfaces and known-vulnerable versions.
 * A version-based lead stays Suspected until a runtime probe proves it. Only pinned, separately
 * installed binaries run through `Bash` (GPL/LGPL tools are never linked). Tools, ceiling and oracle
 * are data; enforcement is deterministic (§8.11).
 */
export const infrastructureSpecialistPersona = registerPersona({
  name: 'infrastructure-specialist',
  mandate:
    'Probe in-scope network services, TLS and configuration (OWASP A05 and A02, WSTG-CONF and WSTG-CRYP), ' +
    'exposed admin interfaces (WSTG-CONF-05) and known-vulnerable versions (A06, CWE-1104). Prove every ' +
    'lead at runtime with a status, version or error signature and a negative control, then submit the ' +
    'candidate. Never judge a finding.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 60,
  maxBudgetUsdDefault: 5,
  allowedTools: [
    'Bash',
    'mcp__blackwing_target__tcp_probe',
    'mcp__blackwing_findings__submit_candidate',
    'mcp__blackwing_findings__attach_evidence',
  ],
  disallowedTools: ['WebFetch', 'WebSearch'],
  declaredOracleTypes: ['status_diff', 'error_signature', 'header_flag'],
  inputs: ['surface_hosts', 'detected_versions', 'test_case_brief'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: true,
  promptRef: { persona: 'infrastructure-specialist', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
