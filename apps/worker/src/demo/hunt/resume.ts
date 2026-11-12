// Resume where it left off: a run that stopped on an error or was stopped by a person is re-queued under the SAME run id
// (service.resumeRun re-checks role, ownership and the pinned authorisation first). The worker rebuilds the test-case map
// and carried spend from the run's last `coverage.summary` event, then re-enters the follow-up loop (no re-recon, no new
// Gate 1), so only the cases left untried are run. Nothing here reaches a target: it is pure parsing of what was recorded.
import { z } from 'zod';

import { caseOutcome, type CaseState } from './context.js';

import type { ResumeState } from './types.js';

const resumeCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  agent: z.string().default('web-api-specialist'),
  status: z.string().default('not_run'),
  note: z.string().nullish(),
  requests: z.number().int().nonnegative().catch(0).default(0),
  candidates: z.number().int().nonnegative().catch(0).default(0),
});

const coverageSchema = z.object({ cases: z.array(z.unknown()).default([]) });

/**
 * Rebuilds the test-case map a resume carries forward from a stored `coverage.summary` event's data. Unusable rows and
 * the runner's own gap rows (a login wall, a failed sign-in: ids prefixed `login-`, which carry no case to re-run) are
 * dropped. The map's values are `CaseState`s whose outcome is preserved by their recorded requests and candidates.
 */
export function resumeCaseMap(data: unknown): Map<string, CaseState> {
  const parsed = coverageSchema.safeParse(data);
  const map = new Map<string, CaseState>();
  if (!parsed.success) return map;
  for (const raw of parsed.data.cases) {
    const row = resumeCaseSchema.safeParse(raw);
    if (!row.success || row.data.id.startsWith('login-')) continue;
    map.set(row.data.id, {
      title: row.data.title,
      agent: row.data.agent,
      status: row.data.status,
      note: row.data.note ?? null,
      requests: row.data.requests,
      candidates: row.data.candidates,
    });
  }
  return map;
}

/** How many carried cases still need a run (neither executed, skipped, blocked nor declined). */
export function untriedOf(cases: Iterable<CaseState>): number {
  let n = 0;
  for (const c of cases) if (caseOutcome(c) === 'not_run') n += 1;
  return n;
}

/** True when a claimed run carries recorded coverage with at least one case left to run, else it is a fresh run. */
export function hasWorkLeft(resume: ResumeState | null): resume is ResumeState {
  return resume !== null && untriedOf(resume.cases.values()) > 0;
}
