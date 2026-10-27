import { registerPersona } from '../persona.js';
import { ADVISORY_DISALLOWED_TOOLS, TRANSCRIPT_SUMMARY_READ_TOOL } from './advisory.js';

/**
 * The `mentor` persona (CONTEXT_PACK §4.6, REFERENCES §2 / §8.1). Stall and loop detection that proposes a
 * recovery strategy. Advisory only: its output never changes a policy decision (§8.11). Passive, read-only,
 * no oracle and no submission. Intervention wiring and eval live in the MENTOR epic.
 */
export const mentorPersona = registerPersona({
  name: 'mentor',
  mandate:
    'Detect stalled or looping sessions from a bounded transcript summary and propose a concrete recovery strategy. Advice only: never test, never change scope, budget or policy.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 15,
  maxBudgetUsdDefault: 2,
  allowedTools: [TRANSCRIPT_SUMMARY_READ_TOOL],
  disallowedTools: ADVISORY_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['transcript_summary', 'run_envelope'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'mentor', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
