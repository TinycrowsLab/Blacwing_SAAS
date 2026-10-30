import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { ADVISORY_DISALLOWED_TOOLS } from './advisory.js';

/** Journal read of prior lessons (read-only; the runtime writes new lessons, not this persona). */
export const JOURNAL_LESSONS_READ_TOOL = 'mcp__blackwing_journal__lessons_read';

/**
 * The `reflector` persona (CONTEXT_PACK §4.6, REFERENCES §2 Reflexion). Post-failure analysis that writes
 * structured lessons so the engagement does not repeat a failure. Lessons are advice, never controls
 * (§8.11). Passive, read-only, no oracle and no submission.
 */
export const reflectorPersona = registerPersona({
  name: 'reflector',
  mandate:
    'Analyse one failed subtask from a bounded transcript summary and prior journal lessons, and produce short structured lessons that avoid repeating the failure. Advice only.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 15,
  maxBudgetUsdDefault: 2,
  allowedTools: [...EXPOSURE_MATRIX.reflector],
  disallowedTools: ADVISORY_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['failed_subtask_transcript_summary', 'journal_lessons'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'reflector', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
