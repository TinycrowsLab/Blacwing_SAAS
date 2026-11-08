import { describe, expect, it, vi } from 'vitest';

import type { SidebarData } from '../../lib/schemas';

vi.mock('../../lib/auth-actions', () => ({ signOutAction: vi.fn() }));

const { outcomeDot, stopTarget, waitingCount, waitingRows } = await import('./sidebar');

const live = (id: string, by: string | null): SidebarData['live'][number] => ({
  id,
  requestId: 'q',
  state: 'running',
  paused: false,
  createdAt: '2026-11-08T10:00:00.000Z',
  startedAt: '2026-11-08T10:00:05.000Z',
  finishedAt: null,
  assetName: 'DVWA',
  requestsUsed: 0,
  costUsd: 0,
  startedBy: by === null ? null : { id: by, name: by === 'u1' ? 'Avery' : 'Sam' },
  queue: null,
});
const slice = (over: Partial<SidebarData>): SidebarData => ({
  workspaceName: null,
  actorId: 'u1',
  gate2: [],
  plans: [],
  releases: [],
  live: [],
  earlier: [],
  counts: null,
  ...over,
});

describe('Stop', () => {
  const data = slice({ live: [live('newest-teammate', 'u2'), live('mine', 'u1')] });

  it('never preselects an audit off its own page: it lists them, with whose each is', () => {
    const t = stopTarget(data, '/decisions');
    expect(t.run).toBeNull();
    expect(t.onRunPage).toBe(false);
    expect(t.choices.map((c) => [c.id, c.startedBy, c.mine])).toEqual([
      ['newest-teammate', 'Sam', false],
      ['mine', 'Avery', true],
    ]);
  });

  it('on an audit’s page acts on that audit only, and on nothing once it ended', () => {
    expect(stopTarget(data, '/runs/mine').run?.id).toBe('mine');
    expect(stopTarget(data, '/runs/mine/results').run?.id).toBe('mine');
    const ended = stopTarget(data, '/runs/finished-one');
    expect(ended.run).toBeNull();
    expect(ended.choices).toEqual([]);
  });

  it('does not call an audit mine without knowing who started it', () => {
    expect(stopTarget(slice({ live: [live('a', null)] }), '/').choices[0]?.mine).toBe(false);
    expect(stopTarget(slice({ actorId: null, live: [live('a', 'u1')] }), '/').choices[0]?.mine).toBe(false);
  });
});

describe('waiting count', () => {
  const lists = {
    gate2: [{ id: 'g', runId: 'r', method: 'POST', url: 'http://x.test/a', deadlineAt: '2026-11-08T10:05:00.000Z' }],
    plans: [{ id: 'p', assetName: 'DVWA', createdAt: '2026-11-08T10:00:00.000Z' }],
  };

  it('is exact when the API counts, never below what is listed', () => {
    expect(waitingCount(slice({ ...lists, counts: { gate1: 3, gate2: 1, gate3: 56, live: 0 } }))).toBe(60);
    expect(waitingCount(slice({ ...lists, counts: { gate1: 0, gate2: 0, gate3: 0, live: 0 } }))).toBe(2);
  });

  it('counts the lists for an older API, and 0 before any data', () => {
    expect(waitingCount(slice(lists))).toBe(2);
    expect(waitingCount(null)).toBe(0);
  });
});

describe('waiting rows', () => {
  it('folds proven findings into one counted row and sends the rest to Decisions', () => {
    const releases = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, title: 't', assetName: null }));
    const gate2 = [{ id: 'g', runId: 'r', method: 'POST', url: 'http://x.test/a', deadlineAt: '2026-11-08T10:05:00.000Z' }];
    expect(waitingRows(slice({ releases, gate2, counts: { gate1: 2, gate2: 1, gate3: 56, live: 0 } }))).toEqual({
      findings: 56,
      more: 2,
    });
    expect(waitingRows(slice({ releases }))).toEqual({ findings: 10, more: 0 });
  });
});

describe('outcome dot', () => {
  it('is green for a finished audit, red for a stopped or failed one', () => {
    expect(outcomeDot('completed')).toBe('ok');
    expect(outcomeDot('killed')).toBe('bad');
    expect(outcomeDot('failed')).toBe('bad');
    expect(outcomeDot('queued')).toBe('faint');
  });
});
