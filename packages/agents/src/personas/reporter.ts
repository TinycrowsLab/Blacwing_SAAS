import { registerPersona } from '../persona.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';

/** Read-only finding and evidence tools, exactly as the findings MCP server names them (`mcp__<server>__<tool>`). */
export const FINDING_READ_TOOL = 'mcp__blackwing_findings__finding_read';
export const EVIDENCE_READ_TOOL = 'mcp__blackwing_findings__evidence_read';

/**
 * `reporter` (CONTEXT_PACK §4.6). Writes up one confirmed, released finding as structured
 * output: impact, evidence narrative, OWASP/CWE/compliance mapping and a CVSS v4.0 interpretation derived
 * from the stored vector. Read-only and passive; it runs no oracle and submits nothing.
 */
export const reporterPersona = registerPersona({
  name: 'reporter',
  mandate:
    'Write up one confirmed finding: impact, an evidence narrative from captured evidence only, OWASP/CWE/' +
    'compliance mapping and a CVSS v4.0 interpretation from the stored vector. Never invent a score.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 30,
  maxBudgetUsdDefault: 3,
  allowedTools: [FINDING_READ_TOOL, EVIDENCE_READ_TOOL],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['confirmed_finding', 'evidence', 'oracle_result'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  structuredOutputSchemaId: 'finding-report.v1',
  promptRef: { persona: 'reporter', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
