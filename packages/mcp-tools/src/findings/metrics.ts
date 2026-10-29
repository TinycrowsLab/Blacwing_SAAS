import { Counter, type Registry } from 'prom-client';

/** Candidate-submission metrics (MCP-009 observability); register once per registry. */
export interface CandidateMetrics {
  /** `mcp_candidates_submitted_total{class}`. */
  readonly submitted: Counter<'class'>;
  /** `mcp_candidate_rejections_total{reason}`. */
  readonly rejections: Counter<'reason'>;
}

export function createCandidateMetrics(registry: Registry): CandidateMetrics {
  return {
    submitted: new Counter({
      name: 'mcp_candidates_submitted_total',
      help: 'Candidate findings accepted by submit_candidate, by vulnerability class.',
      labelNames: ['class'],
      registers: [registry],
    }),
    rejections: new Counter({
      name: 'mcp_candidate_rejections_total',
      help: 'Candidate submissions rejected by submit_candidate, by reason.',
      labelNames: ['reason'],
      registers: [registry],
    }),
  };
}
