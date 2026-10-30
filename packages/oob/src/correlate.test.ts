import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { correlateInteraction, type OobHit } from './correlate.js';

const TOKEN = 'a1b2c3d4e5';
const OTHER_TENANT_TOKEN = 'z9y8x7w6v5';

const hit = (overrides: Partial<OobHit> = {}): OobHit => ({
  token: TOKEN,
  channel: 'dns',
  offsetMs: 1_000,
  ...overrides,
});

describe('correlateInteraction', () => {
  it('correlates an interaction on the per-test token, channel and window', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 30_000,
        interactions: [hit()],
      }),
    ).toEqual(hit());
  });

  it('does not correlate an uncorrelated interaction carrying another token', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 30_000,
        interactions: [hit({ token: OTHER_TENANT_TOKEN })],
      }),
    ).toBeUndefined();
  });

  it('requires an exact token: a prefix or a case variant does not correlate', () => {
    for (const token of [TOKEN.slice(0, 8), TOKEN.toUpperCase(), `${TOKEN}x`]) {
      expect(
        correlateInteraction({
          token: TOKEN,
          channel: 'dns',
          windowMs: 30_000,
          interactions: [hit({ token })],
        }),
      ).toBeUndefined();
    }
  });

  it('does not correlate on a different channel than declared', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'http',
        windowMs: 30_000,
        interactions: [hit({ channel: 'dns' })],
      }),
    ).toBeUndefined();
  });

  it('does not count a late interaction after the window', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 5_000,
        interactions: [hit({ offsetMs: 5_001 })],
      }),
    ).toBeUndefined();
  });

  it('counts an interaction exactly at the window edge', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 5_000,
        interactions: [hit({ offsetMs: 5_000 })],
      }),
    ).toEqual(hit({ offsetMs: 5_000 }));
  });

  it('does not count a hit that arrives before the probe was sent', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 30_000,
        interactions: [hit({ offsetMs: -1 })],
      }),
    ).toBeUndefined();
  });

  it('ignores a non-finite arrival offset rather than matching it', () => {
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 30_000,
        interactions: [hit({ offsetMs: Number.NaN })],
      }),
    ).toBeUndefined();
  });

  it('returns the earliest correlating interaction when several arrive', () => {
    const late = hit({ offsetMs: 9_000 });
    const early = hit({ offsetMs: 2_000 });
    expect(
      correlateInteraction({
        token: TOKEN,
        channel: 'dns',
        windowMs: 30_000,
        interactions: [late, early],
      }),
    ).toEqual(early);
  });

  it('returns undefined when there are no interactions', () => {
    expect(
      correlateInteraction({ token: TOKEN, channel: 'dns', windowMs: 30_000, interactions: [] }),
    ).toBeUndefined();
  });

  it('refuses a window outside 1 to 300000 ms', () => {
    for (const windowMs of [0, -1, 1.5, 300_001, Number.NaN]) {
      expect(() =>
        correlateInteraction({ token: TOKEN, channel: 'dns', windowMs, interactions: [] }),
      ).toThrow(ValidationError);
    }
  });
});
