import { registerPersona } from '../persona.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';
import { EVIDENCE_READ_TOOL, FINDING_READ_TOOL } from './reporter.js';

/** Read-only source context for white-box runs, exactly as the source MCP server names it. */
const SOURCE_READ_TOOL = 'mcp__blackwing_source__source_read';

/**
 * `remediation` (CONTEXT_PACK §4.6). Produces fix guidance, ticket text and a retest plan for
 * one confirmed finding, tied to its CWE and remediation pattern. Read-only and passive; the source it reads
 * is untrusted data.
 */
export const remediationPersona = registerPersona({
  name: 'remediation',
  mandate:
    'Produce fix guidance (code-level in white-box runs, class-level otherwise), ticket text and a retest ' +
    'plan for one confirmed finding, citing standard IDs and remediation patterns only.',
  tierAlias: 'standard',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [FINDING_READ_TOOL, EVIDENCE_READ_TOOL, SOURCE_READ_TOOL],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['confirmed_finding', 'finding_report', 'source_context'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'remediation', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
