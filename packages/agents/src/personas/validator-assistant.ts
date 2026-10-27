import { registerPersona } from '../persona.js';
import { SUBMIT_CANDIDATE_TOOL } from './active-recon.js';
import { ORACLE_CATALOGUE } from './oracles.js';
import { PLANNING_DISALLOWED_TOOLS, TEST_CASE_LIBRARY_READ_TOOL } from './planner.js';

/** Candidate-finding read tool, exactly as the findings MCP server names it (`mcp__<server>__<tool>`). */
export const CANDIDATE_READ_TOOL = 'mcp__blackwing_findings__candidate_read';
/** Captured-evidence read tool (metadata and artefacts of a candidate). */
export const EVIDENCE_READ_TOOL = 'mcp__blackwing_findings__evidence_read';

/**
 * `validator-assistant` (REFERENCES §8.1, CONTEXT_PACK §4.6). Normalises one candidate into a
 * deterministic replay spec bound to its pre-declared oracle and negative control. It binds, never judges:
 * confirmed or suspected is decided by the deterministic Validator. Read-only; never submits.
 */
export const validatorAssistantPersona = registerPersona({
  name: 'validator-assistant',
  mandate:
    'Normalise one submitted candidate finding into a complete, deterministic replay spec: request and ' +
    'response steps, the pre-declared oracle and its parameters, and the negative control. Bind the ' +
    'declared oracle; never judge whether the finding is confirmed or suspected, and never invent or ' +
    'change an oracle.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 30,
  maxBudgetUsdDefault: 2,
  allowedTools: [CANDIDATE_READ_TOOL, EVIDENCE_READ_TOOL, TEST_CASE_LIBRARY_READ_TOOL],
  disallowedTools: [...PLANNING_DISALLOWED_TOOLS, SUBMIT_CANDIDATE_TOOL],
  declaredOracleTypes: [...ORACLE_CATALOGUE],
  inputs: ['candidate_finding', 'evidence', 'test_case_oracle', 'negative_control', 'run_envelope'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  structuredOutputSchemaId: 'replay-spec.v1',
  promptRef: { persona: 'validator-assistant', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
