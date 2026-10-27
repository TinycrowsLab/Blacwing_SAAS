import { registerPersona } from '../persona.js';

/**
 * The `auth-logic-specialist` persona (REGISTRY-issue #659, CONTEXT_PACK §4.6, REFERENCES §8.1).
 *
 * Deep specialist for the multi-role authorisation matrix (F9): access control, BOLA/BFLA/IDOR,
 * privilege escalation and business-logic abuse, tested by switching between role sessions obtained
 * by reference through the session manager. Each candidate is bound to an access-matrix oracle and a
 * negative control. Tools, ceiling and oracle are data; enforcement is deterministic (§8.11).
 */

/** Role-switching tools (session manager). Credentials are used by reference only (§8.7). */
const AUTH_LOGIC_SESSION_TOOLS = [
  'mcp__blackwing_session__use_role',
  'mcp__blackwing_session__check_session',
] as const;

/** Target-interaction tools, routed through the egress gateway. */
const AUTH_LOGIC_TARGET_TOOLS = [
  'mcp__blackwing_target__http_request',
  'mcp__blackwing_target__http_batch',
  'mcp__playwright__*',
] as const;

/** Out-of-band callback tools (blind checks) and the reversal journal. */
const AUTH_LOGIC_OOB_JOURNAL_TOOLS = [
  'mcp__blackwing_oob__*',
  'mcp__blackwing_journal__*',
] as const;

/** Finding submission. Candidates only; the Validator judges, never this persona (§8.11). */
export const AUTH_LOGIC_SUBMIT_TOOL = 'mcp__blackwing_findings__submit_candidate';
const AUTH_LOGIC_ATTACH_EVIDENCE_TOOL = 'mcp__blackwing_findings__attach_evidence';

export const authLogicSpecialistPersona = registerPersona({
  name: 'auth-logic-specialist',
  mandate:
    'Test the multi-role authorisation matrix for broken access control (A01), BOLA (API1, CWE-639), BFLA (API5), ' +
    'IDOR (CWE-639, CWE-862), privilege escalation (CWE-269), business-logic abuse (WSTG-BUSL) and race ' +
    'conditions (CWE-362, state_changing only when approved). Switch between role sessions, declare the ' +
    'access-matrix oracle and a negative control for each candidate, and submit candidates. Never judge a finding.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 80,
  maxBudgetUsdDefault: 5,
  allowedTools: [
    'Bash',
    ...AUTH_LOGIC_TARGET_TOOLS,
    ...AUTH_LOGIC_SESSION_TOOLS,
    ...AUTH_LOGIC_OOB_JOURNAL_TOOLS,
    AUTH_LOGIC_SUBMIT_TOOL,
    AUTH_LOGIC_ATTACH_EVIDENCE_TOOL,
  ],
  disallowedTools: ['WebFetch', 'WebSearch'],
  declaredOracleTypes: ['access_matrix', 'status_diff', 'reflected_marker'],
  inputs: ['role_matrix', 'role_sessions', 'test_case_brief', 'surface_model'],
  intrusivenessCeiling: 'active_safe',
  requiresSubmission: true,
  promptRef: { persona: 'auth-logic-specialist', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
