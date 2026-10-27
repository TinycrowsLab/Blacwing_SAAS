import { registerPersona } from '../persona.js';

/**
 * The `session-setup` persona (REGISTRY-011, CONTEXT_PACK §4.6 / §3.2, F10).
 *
 * Verifies and records per-role login recipes so authenticated testing has valid sessions. It makes
 * no state-changing request and handles credentials by reference only (§8.7). Tools and ceiling are
 * data; enforcement is deterministic (§8.11).
 */
export const SESSION_SETUP_ALLOWED_TOOLS = ['mcp__blackwing_session__*', 'mcp__playwright__*'];

export const sessionSetupPersona = registerPersona({
  name: 'session-setup',
  mandate:
    'Verify and record the login recipe for each role in the role matrix so authenticated testing has valid sessions. Perform no state-changing actions. Use credentials by reference only and respect the lockout guard.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: SESSION_SETUP_ALLOWED_TOOLS,
  disallowedTools: ['WebFetch', 'WebSearch'],
  declaredOracleTypes: [],
  inputs: ['role_matrix', 'credential_references', 'login_recipes'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: false,
  promptRef: { persona: 'session-setup', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
