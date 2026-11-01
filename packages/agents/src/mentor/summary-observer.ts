import { metrics } from '@opentelemetry/api';

import type { Logger } from '@blackwing/logger';

/**
 * Observer port for the mentor summary (MENTOR-002, #421). The default adapter records OTel metrics and the
 * `mentor.summary` log line. Metric labels are bounded (a boolean), and the log carries ids and counts only,
 * never the summary text, tool arguments or their digests.
 */
export interface MentorSummaryEvent {
  readonly sessionId: string;
  /** Serialised summary size in bytes. */
  readonly bytes: number;
  /** Secret values and credential shapes replaced while building the summary. */
  readonly redactions: number;
  readonly actionsCount: number;
  readonly truncated: boolean;
  readonly transcriptAvailable: boolean;
}

export interface MentorSummaryObserver {
  summarised(event: MentorSummaryEvent): void;
}

export function createNoOpSummaryObserver(): MentorSummaryObserver {
  return { summarised: () => undefined };
}

export function createOtelMentorSummaryObserver(logger: Logger): MentorSummaryObserver {
  const meter = metrics.getMeter('@blackwing/agents');
  const summaries = meter.createCounter('mentor_summaries_total', {
    description: 'Mentor transcript summaries built, by whether the transcript was readable',
  });
  const summaryBytes = meter.createHistogram('mentor_summary_bytes', {
    description: 'Serialised size of a mentor transcript summary',
    unit: 'By',
  });
  const redactions = meter.createCounter('mentor_summary_redactions_total', {
    description: 'Secret values redacted while building mentor transcript summaries',
  });
  return {
    summarised({
      sessionId,
      bytes,
      redactions: redacted,
      actionsCount,
      truncated,
      transcriptAvailable,
    }) {
      summaries.add(1, { transcript_available: String(transcriptAvailable) });
      summaryBytes.record(bytes);
      if (redacted > 0) redactions.add(redacted);
      logger.info({ sessionId, actionsCount, truncated }, 'mentor.summary');
    },
  };
}
