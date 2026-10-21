import { describe, expect, it } from 'vitest';

import { computeSaTimeline } from './timeline.js';

import type { SaTimeBounds } from './types.js';

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;

/** 22:00 London every day, open for 4 hours. */
const nightly: SaTimeBounds = {
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-12-31T00:00:00.000Z',
  testWindows: [{ cron: '0 22 * * *', timezone: 'Europe/London', durationMs: 4 * HOUR }],
};

describe('computeSaTimeline', () => {
  it('is expired at and after expiresAt and never reports a window then', () => {
    const t = computeSaTimeline(nightly, at('2026-12-31T00:00:00.000Z'));
    expect(t).toMatchObject({ phase: 'expired', closeAt: null, nextOpenAt: null });
    expect(computeSaTimeline(nightly, at('2027-01-01T00:00:00.000Z')).phase).toBe('expired');
  });

  it('is open inside a window with the close instant, closed outside with the next open', () => {
    const open = computeSaTimeline(nightly, at('2026-02-10T23:00:00.000Z'));
    expect(open).toMatchObject({ phase: 'open', closeAt: '2026-02-11T02:00:00.000Z' });
    const closed = computeSaTimeline(nightly, at('2026-02-11T03:00:00.000Z'));
    expect(closed).toMatchObject({
      phase: 'closed',
      closeAt: null,
      nextOpenAt: '2026-02-11T22:00:00.000Z',
    });
  });

  it('closeAt never exceeds expiresAt', () => {
    const t = computeSaTimeline(
      { ...nightly, expiresAt: '2026-02-11T00:30:00.000Z' },
      at('2026-02-10T23:00:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'open', closeAt: '2026-02-11T00:30:00.000Z' });
  });

  it('has no next window when none opens before expiry', () => {
    const t = computeSaTimeline(
      { ...nightly, expiresAt: '2026-02-11T12:00:00.000Z' },
      at('2026-02-11T03:00:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'closed', nextOpenAt: null });
  });

  describe('Europe/London across the DST boundary', () => {
    it('opens at 22:00 GMT (22:00Z) the night before spring forward', () => {
      const t = computeSaTimeline(nightly, at('2026-03-28T12:00:00.000Z'));
      expect(t.nextOpenAt).toBe('2026-03-28T22:00:00.000Z');
    });

    it('opens at 22:00 BST (21:00Z) the night after spring forward (2026-03-29)', () => {
      const t = computeSaTimeline(nightly, at('2026-03-29T12:00:00.000Z'));
      expect(t.nextOpenAt).toBe('2026-03-29T21:00:00.000Z');
      const open = computeSaTimeline(nightly, at('2026-03-29T21:30:00.000Z'));
      expect(open).toMatchObject({ phase: 'open', closeAt: '2026-03-30T01:00:00.000Z' });
    });

    it('opens at 22:00 BST (21:00Z) the night before fall back and 22:00 GMT (22:00Z) after (2026-10-25)', () => {
      expect(computeSaTimeline(nightly, at('2026-10-24T12:00:00.000Z')).nextOpenAt).toBe(
        '2026-10-24T21:00:00.000Z',
      );
      expect(computeSaTimeline(nightly, at('2026-10-25T12:00:00.000Z')).nextOpenAt).toBe(
        '2026-10-25T22:00:00.000Z',
      );
    });

    it('a window spanning the transition lasts its real duration', () => {
      const overnight: SaTimeBounds = {
        ...nightly,
        testWindows: [{ cron: '0 0 * * *', timezone: 'Europe/London', durationMs: 3 * HOUR }],
      };
      // Midnight 2026-03-29 is GMT; clocks jump at 01:00 -> 02:00, so 3 real hours end at 04:00 BST.
      const t = computeSaTimeline(overnight, at('2026-03-29T00:30:00.000Z'));
      expect(t).toMatchObject({ phase: 'open', closeAt: '2026-03-29T03:00:00.000Z' });
    });
  });

  it('evaluates in the window zone, not the host zone', () => {
    const tokyo: SaTimeBounds = {
      ...nightly,
      testWindows: [{ cron: '0 9 * * *', timezone: 'Asia/Tokyo', durationMs: HOUR }],
    };
    expect(computeSaTimeline(tokyo, at('2026-05-01T12:00:00.000Z')).nextOpenAt).toBe(
      '2026-05-02T00:00:00.000Z',
    );
  });

  it('merges overlapping and abutting windows into one open run', () => {
    const t = computeSaTimeline(
      {
        ...nightly,
        testWindows: [
          { cron: '0 22 * * *', timezone: 'UTC', durationMs: 2 * HOUR },
          { cron: '0 23 * * *', timezone: 'UTC', durationMs: 3 * HOUR },
          { cron: '0 2 * * *', timezone: 'UTC', durationMs: HOUR },
        ],
      },
      at('2026-02-10T22:30:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'open', closeAt: '2026-02-11T03:00:00.000Z' });
  });

  it('treats an unparseable cron or zone as closed, never open (fail safe)', () => {
    const t = computeSaTimeline(
      {
        ...nightly,
        testWindows: [
          { cron: 'not a cron', timezone: 'UTC', durationMs: HOUR },
          { cron: '* * * * *', timezone: 'Mars/Olympus', durationMs: HOUR },
          { cron: '* * * * *', timezone: 'local', durationMs: HOUR },
          { cron: '* * * * *', timezone: 'UTC', durationMs: 0 },
        ],
      },
      at('2026-02-10T22:30:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'closed', nextOpenAt: null, invalidWindows: 4 });
  });

  it('a valid window still works next to an invalid one', () => {
    const t = computeSaTimeline(
      {
        ...nightly,
        testWindows: [
          { cron: 'bad', timezone: 'UTC', durationMs: HOUR },
          { cron: '0 22 * * *', timezone: 'UTC', durationMs: HOUR },
        ],
      },
      at('2026-02-10T22:10:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'open', invalidWindows: 1 });
  });

  it('drops a pathological window instead of scanning forever', () => {
    const t = computeSaTimeline(
      {
        ...nightly,
        testWindows: [{ cron: '* * * * * *', timezone: 'UTC', durationMs: 7 * 24 * HOUR }],
      },
      at('2026-02-10T22:10:00.000Z'),
    );
    expect(t.phase).toBe('closed');
  });

  it('is closed before validFrom and opens at validFrom if a window is then open', () => {
    const t = computeSaTimeline(
      {
        ...nightly,
        validFrom: '2026-02-10T22:30:00.000Z',
        testWindows: [{ cron: '0 22 * * *', timezone: 'UTC', durationMs: 2 * HOUR }],
      },
      at('2026-02-10T12:00:00.000Z'),
    );
    expect(t).toMatchObject({ phase: 'closed', nextOpenAt: '2026-02-10T22:30:00.000Z' });
  });

  it('an SA with no test windows is open from validFrom to expiry', () => {
    const none: SaTimeBounds = { ...nightly, testWindows: [] };
    expect(computeSaTimeline(none, at('2026-06-01T00:00:00.000Z'))).toMatchObject({
      phase: 'open',
      closeAt: '2026-12-31T00:00:00.000Z',
    });
    expect(computeSaTimeline(none, at('2025-06-01T00:00:00.000Z'))).toMatchObject({
      phase: 'closed',
      nextOpenAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('fails closed on unreadable bounds', () => {
    const t = computeSaTimeline(
      { ...nightly, expiresAt: 'tomorrow' },
      at('2026-02-10T12:00:00.000Z'),
    );
    expect(t.phase).toBe('expired');
  });
});
