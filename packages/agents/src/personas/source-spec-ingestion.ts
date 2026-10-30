import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { registerPersona } from '../persona.js';
import { PLANNING_DISALLOWED_TOOLS } from './planner.js';

/** Surface-model write tool, exactly as the surface MCP server names it (`mcp__<server>__<tool>`). */
export const SURFACE_UPSERT_TOOL = 'mcp__blackwing_surface__surface_upsert';

/**
 * The `source-spec-ingestion` persona (CONTEXT_PACK §4.6). Grey and white box only. Passive class: it reads
 * mounted specifications and source, maps their routes to runtime endpoints in the surface model, and flags
 * secrets it finds without ever using them (§1.1, §8.7). It never runs code and never reaches the network.
 */
export const sourceSpecIngestionPersona = registerPersona({
  name: 'source-spec-ingestion',
  mandate:
    'Turn mounted OpenAPI, Postman, GraphQL and HAR specifications, and source code, into surface-model nodes that map source routes to runtime endpoints (WSTG-INFO, WSTG-CONF). Flag discovered secrets for redaction and never use them.',
  tierAlias: 'deep',
  effort: 'high',
  maxTurns: 40,
  maxBudgetUsdDefault: 5,
  allowedTools: [...EXPOSURE_MATRIX['source-spec-ingestion']],
  disallowedTools: PLANNING_DISALLOWED_TOOLS,
  declaredOracleTypes: [],
  inputs: ['mounted_specs', 'mounted_source', 'deploy_manifests', 'run_envelope'],
  intrusivenessCeiling: 'passive',
  requiresSubmission: false,
  promptRef: { persona: 'source-spec-ingestion', version: '1.0.0' },
  guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
});
