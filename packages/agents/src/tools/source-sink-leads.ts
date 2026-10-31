/**
 * CODESPEC-004 (#511): assembles `SourceSinkLead[]` from deterministic sink matches and model-proposed traces.
 *
 * Sinks come only from the opengrep pass. The LLM-guided tracer may connect a source to one of those sinks, but
 * it cannot invent a sink: a trace whose sink does not match an opengrep hit (same CWE, path and start line) is
 * discarded. The emitted lead carries the sink location from the match, so provenance stays deterministic (§8.9).
 * A lead is a hypothesis, never proof; it is never a finding (§8.11, §1.1).
 */
import { z } from 'zod';

import { type CodeLocation, SourceSinkLeadSchema, type SourceSinkLead } from '@blackwing/contracts';
import { newId } from '@blackwing/ids';

import type { OpengrepMatch } from './opengrep-runner.js';

/** A trace proposed by the code specialist. Parsed at the boundary; the model output is untrusted. */
const traceSchema = z.strictObject({
  cweId: z.string(),
  source: z.strictObject({
    path: z.string(),
    startLine: z.int(),
    endLine: z.int().optional(),
    symbol: z.string().optional(),
  }),
  sink: z.strictObject({ path: z.string(), startLine: z.int() }),
  pathSummary: z.string(),
  confidence: z.number(),
  reachabilityHypothesis: z.strictObject({
    entrypoint: z.string(),
    roleHints: z.array(z.string()),
  }),
});

export interface AssembleLeadsInput {
  matches: readonly OpengrepMatch[];
  /** Raw model output; each entry is validated before use. */
  traces: readonly unknown[];
  /** Lead cap (`WHITEBOX_MAX_LEADS`). Overflow is recorded as a coverage note, never dropped silently. */
  maxLeads: number;
  /** Files the engine skipped, each reported as a coverage note. */
  skipped?: readonly { path: string; reason: string }[];
  /** Injectable for deterministic tests; defaults to UUIDv7. */
  newLeadId?: () => string;
}

export interface AssembleLeadsResult {
  leads: SourceSinkLead[];
  /** Human-readable coverage notes (COVERAGE). Empty results still explain themselves. */
  coverageNotes: string[];
  /** Traces dropped for failing validation, lacking a matching sink, or duplicating a stronger lead. */
  discarded: number;
}

/** Dedup key from the requirements: `(cweId, sink.path, sink.startLine)`. */
export function leadDedupKey(cweId: string, path: string, startLine: number): string {
  return `${cweId}|${path}|${String(startLine)}`;
}

export function assembleSourceSinkLeads(input: AssembleLeadsInput): AssembleLeadsResult {
  const coverageNotes: string[] = [];
  const newLeadId = input.newLeadId ?? newId;
  let discarded = 0;

  if (input.matches.length === 0) {
    coverageNotes.push('no sink matches: zero leads (empty repo or unsupported language)');
  }
  for (const skip of input.skipped ?? []) {
    coverageNotes.push(`skipped ${skip.path}: ${skip.reason}`);
  }

  const sinkIndex = new Map<string, OpengrepMatch>();
  for (const match of input.matches) {
    const key = leadDedupKey(match.cweId, match.location.path, match.location.startLine);
    if (!sinkIndex.has(key)) {
      sinkIndex.set(key, match);
    }
  }

  const byKey = new Map<string, SourceSinkLead>();
  for (const raw of input.traces) {
    const parsed = traceSchema.safeParse(raw);
    if (!parsed.success) {
      discarded += 1;
      continue;
    }
    const trace = parsed.data;
    const match = sinkIndex.get(leadDedupKey(trace.cweId, trace.sink.path, trace.sink.startLine));
    if (match === undefined) {
      discarded += 1;
      continue;
    }
    const source: CodeLocation = {
      repoRef: match.location.repoRef,
      commitSha: match.location.commitSha,
      path: trace.source.path,
      startLine: trace.source.startLine,
      ...(trace.source.endLine === undefined ? {} : { endLine: trace.source.endLine }),
      ...(trace.source.symbol === undefined ? {} : { symbol: trace.source.symbol }),
    };
    const lead = SourceSinkLeadSchema.safeParse({
      id: newLeadId(),
      cweId: match.cweId,
      owaspRefs: match.owaspRef === undefined ? [] : [match.owaspRef],
      wstgRefs: match.wstgRef === undefined ? [] : [match.wstgRef],
      source,
      sink: match.location,
      pathSummary: trace.pathSummary,
      confidence: trace.confidence,
      reachabilityHypothesis: trace.reachabilityHypothesis,
    });
    if (!lead.success) {
      discarded += 1;
      continue;
    }
    const key = leadDedupKey(lead.data.cweId, lead.data.sink.path, lead.data.sink.startLine);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, lead.data);
    } else {
      discarded += 1;
      if (lead.data.confidence > existing.confidence) {
        byKey.set(key, lead.data);
      }
    }
  }

  const ranked = [...byKey.values()].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.sink.path.localeCompare(b.sink.path) ||
      a.sink.startLine - b.sink.startLine,
  );
  const leads = ranked.slice(0, input.maxLeads);
  const overflow = ranked.length - leads.length;
  if (overflow > 0) {
    coverageNotes.push(
      `WHITEBOX_MAX_LEADS=${String(input.maxLeads)} reached: ${String(overflow)} lower-ranked leads not emitted`,
    );
  }
  return { leads, coverageNotes, discarded };
}
