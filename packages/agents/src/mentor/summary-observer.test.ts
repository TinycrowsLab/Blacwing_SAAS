// MENTOR-002 (#421): the mentor.summary log carries ids and counts only, never summary text or arguments.
import { describe, expect, it, vi } from 'vitest';

import { createOtelMentorSummaryObserver, createNoOpSummaryObserver } from './summary-observer.js';

import type { Logger } from '@blackwing/logger';

function fakeLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  return { logger: { info } as unknown as Logger, info };
}

describe('createOtelMentorSummaryObserver', () => {
  it('logs mentor.summary with session, action count and truncation only', () => {
    const { logger, info } = fakeLogger();
    createOtelMentorSummaryObserver(logger).summarised({
      sessionId: 'sess-1',
      bytes: 812,
      redactions: 1,
      actionsCount: 4,
      truncated: true,
      transcriptAvailable: true,
    });
    expect(info).toHaveBeenCalledWith(
      { sessionId: 'sess-1', actionsCount: 4, truncated: true },
      'mentor.summary',
    );
  });

  it('does not throw for a telemetry-only summary', () => {
    const { logger, info } = fakeLogger();
    expect(() => {
      createOtelMentorSummaryObserver(logger).summarised({
        sessionId: 'sess-2',
        bytes: 120,
        redactions: 0,
        actionsCount: 0,
        truncated: false,
        transcriptAvailable: false,
      });
    }).not.toThrow();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('createNoOpSummaryObserver', () => {
  it('accepts events and does nothing', () => {
    expect(() => {
      createNoOpSummaryObserver().summarised({
        sessionId: 's',
        bytes: 1,
        redactions: 0,
        actionsCount: 0,
        truncated: false,
        transcriptAvailable: true,
      });
    }).not.toThrow();
  });
});
