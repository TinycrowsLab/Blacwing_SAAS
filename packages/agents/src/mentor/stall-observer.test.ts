// MENTOR-001 (#420): the default observer logs `stall.detected` with ids and reasons only, and never logs
// arguments or their digests.
import { describe, expect, it, vi } from 'vitest';

import { createOtelStallObserver } from './stall-observer.js';

import type { Logger } from '@blackwing/logger';

function fakeLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  return { logger: { info } as unknown as Logger, info };
}

describe('createOtelStallObserver', () => {
  it('logs stall.detected with session, reasons and severity when stalled', () => {
    const { logger, info } = fakeLogger();
    createOtelStallObserver(logger).evaluated({
      sessionId: 'sess-1',
      signal: { stalled: true, reasons: ['no_progress', 'tool_loop'], severity: 'medium' },
      durationMs: 0.4,
    });
    expect(info).toHaveBeenCalledWith(
      { sessionId: 'sess-1', reasons: ['no_progress', 'tool_loop'], severity: 'medium' },
      'stall.detected',
    );
  });

  it('stays silent for a healthy window', () => {
    const { logger, info } = fakeLogger();
    createOtelStallObserver(logger).evaluated({
      sessionId: 'sess-1',
      signal: { stalled: false, reasons: [], severity: 'low' },
      durationMs: 0.1,
    });
    expect(info).not.toHaveBeenCalled();
  });
});
