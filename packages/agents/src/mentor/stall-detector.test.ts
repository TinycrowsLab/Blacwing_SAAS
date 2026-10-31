// MENTOR-001 (#420): each stall rule fires on a crafted window, stays silent on healthy progress, and the
// severity, config and window edge cases hold.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { StallDetector, type StallObserver, type StallSignal } from './stall-detector.js';
import { type StallEventInput, StallWindow } from './stall-window.js';

import type { StallThresholds } from '@blackwing/config';

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const at = (minutes: number, seconds = 0): string =>
  new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString();

const THRESHOLDS: StallThresholds = {
  noProgressTurns: 6,
  toolLoopRepeats: 4,
  errorLoop: 3,
  budgetDeltaUsd: 0.5,
  subtaskMaxMinutes: 20,
};

const noProgress = { evidence: 0, subtaskChanges: 0, surfaceNodes: 0 };
const progressed = { evidence: 1, subtaskChanges: 0, surfaceNodes: 0 };

let seq = 0;
function turn(
  i: number,
  opts: { progress?: typeof noProgress; cost?: number; minute?: number } = {},
): StallEventInput {
  return {
    kind: 'turn',
    turnId: `turn-${String(i)}`,
    at: at(opts.minute ?? i),
    costUsd: opts.cost ?? 0,
    progress: opts.progress ?? noProgress,
  };
}
function tool(
  turnIndex: number,
  args: unknown,
  opts: { outcome?: 'ok' | 'error' | 'denied'; errorKind?: string; tool?: string } = {},
): StallEventInput {
  seq++;
  return {
    kind: 'tool',
    turnId: `turn-${String(turnIndex)}`,
    toolUseId: `tu-${String(seq)}`,
    at: at(turnIndex),
    tool: opts.tool ?? 'http_probe',
    args,
    outcome: opts.outcome ?? 'ok',
    ...(opts.errorKind === undefined ? {} : { errorKind: opts.errorKind }),
  };
}

function windowOf(events: StallEventInput[], options: { maxEvents?: number } = {}): StallWindow {
  const w = new StallWindow({ sessionId: 'sess-1', ...options });
  for (const e of events) w.push(e);
  return w;
}

const detector = (
  thresholds: StallThresholds = THRESHOLDS,
  observer?: StallObserver,
): StallDetector =>
  new StallDetector(observer === undefined ? { thresholds } : { thresholds, observer });

describe('StallDetector rules', () => {
  it('no_progress fires after N consecutive turns without progress, and not before the window fills', () => {
    const quietTurns = Array.from({ length: 6 }, (_, i) => turn(i));
    expect(detector().evaluate(windowOf(quietTurns.slice(0, 5)))).toMatchObject({
      stalled: false,
      reasons: [],
    });
    expect(detector().evaluate(windowOf(quietTurns))).toMatchObject({
      stalled: true,
      reasons: ['no_progress'],
    });
  });

  it('a progress turn resets no_progress: a long progressing session is not flagged', () => {
    const events: StallEventInput[] = [];
    for (let i = 0; i < 40; i++)
      events.push(turn(i, { progress: i % 4 === 3 ? progressed : noProgress }));
    expect(detector().evaluate(windowOf(events))).toMatchObject({ stalled: false, reasons: [] });
  });

  it('a subtask status change counts as progress', () => {
    const events: StallEventInput[] = [turn(0), turn(1), turn(2), turn(3), turn(4)];
    events.push({ kind: 'subtask', at: at(4, 30), subtaskId: 's1', status: 'completed' });
    events.push(turn(5), turn(6), turn(7), turn(8));
    expect(detector().evaluate(windowOf(events)).reasons).not.toContain('no_progress');
  });

  it('tool_loop fires on N repeats of the same tool with the same normalised arguments', () => {
    const events: StallEventInput[] = [turn(0)];
    for (let i = 1; i <= 4; i++) events.push(tool(0, { url: 'http://lab/x' }), turn(i));
    expect(detector().evaluate(windowOf(events)).reasons).toEqual(['tool_loop']);
  });

  it('tool_loop stays silent for varied arguments and for repeats below the threshold', () => {
    const varied: StallEventInput[] = [turn(0)];
    for (let i = 1; i <= 6; i++) varied.push(tool(0, { url: `http://lab/${String(i)}` }), turn(i));
    expect(detector().evaluate(windowOf(varied)).reasons).not.toContain('tool_loop');
    const three: StallEventInput[] = [
      turn(0),
      tool(0, { q: 1 }),
      tool(0, { q: 1 }),
      tool(0, { q: 1 }),
    ];
    expect(detector().evaluate(windowOf(three)).reasons).not.toContain('tool_loop');
  });

  it('tool_loop is robust to volatile-field noise and homoglyph/compat variation (normalised hashing)', () => {
    const events: StallEventInput[] = [turn(0)];
    events.push(
      tool(0, { url: 'http://lab/x', timestamp: '2026-10-31T10:00:01.000Z' }),
      tool(0, { url: 'http://lab/x', nonce: 'n-1' }),
      tool(0, { url: 'http://ｌａｂ/x' }),
      tool(0, { url: 'http://lab/x', requestId: 'r-9' }),
    );
    expect(detector().evaluate(windowOf(events)).reasons).toEqual(['tool_loop']);
  });

  it('error_loop fires on N consecutive errors of the same kind, and denials count', () => {
    const events: StallEventInput[] = [
      turn(0),
      tool(0, { a: 1 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
      tool(0, { a: 2 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
      tool(0, { a: 3 }, { outcome: 'denied', errorKind: 'TIMEOUT' }),
    ];
    expect(detector().evaluate(windowOf(events)).reasons).toEqual(['error_loop']);
  });

  it('error_loop stays silent for mixed kinds or a success breaking the run', () => {
    const mixed: StallEventInput[] = [
      turn(0),
      tool(0, { a: 1 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
      tool(0, { a: 2 }, { outcome: 'error', errorKind: 'EGRESS_DENIED' }),
      tool(0, { a: 3 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
    ];
    expect(detector().evaluate(windowOf(mixed)).reasons).not.toContain('error_loop');
    const broken: StallEventInput[] = [
      turn(0),
      tool(0, { a: 1 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
      tool(0, { a: 2 }, { outcome: 'ok' }),
      tool(0, { a: 3 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
      tool(0, { a: 4 }, { outcome: 'error', errorKind: 'TIMEOUT' }),
    ];
    expect(detector().evaluate(windowOf(broken)).reasons).not.toContain('error_loop');
  });

  it('budget_crawl fires when spend since the last progress exceeds the delta, and not at the delta exactly', () => {
    const over = [turn(0, { cost: 0.3 }), turn(1, { cost: 0.3 })];
    expect(detector().evaluate(windowOf(over)).reasons).toEqual(['budget_crawl']);
    const exact = [turn(0, { cost: 0.25 }), turn(1, { cost: 0.25 })];
    expect(detector().evaluate(windowOf(exact)).reasons).not.toContain('budget_crawl');
  });

  it('budget_crawl ignores spend that happened before the last progress marker', () => {
    const events = [
      turn(0, { cost: 5 }),
      turn(1, { progress: progressed }),
      turn(2, { cost: 0.1 }),
    ];
    expect(detector().evaluate(windowOf(events)).reasons).not.toContain('budget_crawl');
  });

  it('time_box fires on event timestamps when a subtask runs past its limit, even with quiet turns', () => {
    const events: StallEventInput[] = [
      { kind: 'subtask', at: at(0), subtaskId: 'sub-a', status: 'started' },
      { kind: 'turn', turnId: 'q', at: at(25), costUsd: 0, progress: noProgress },
    ];
    expect(detector().evaluate(windowOf(events)).reasons).toEqual(['time_box']);
  });

  it('time_box stays silent after completion, within the limit, and uses no local clock', () => {
    const done: StallEventInput[] = [
      { kind: 'subtask', at: at(0), subtaskId: 'sub-a', status: 'started' },
      { kind: 'subtask', at: at(5), subtaskId: 'sub-a', status: 'completed' },
      { kind: 'turn', turnId: 'q', at: at(40), costUsd: 0, progress: noProgress },
    ];
    expect(detector().evaluate(windowOf(done)).reasons).not.toContain('time_box');
    const within: StallEventInput[] = [
      { kind: 'subtask', at: at(0), subtaskId: 'sub-a', status: 'started' },
      { kind: 'turn', turnId: 'q', at: at(20), costUsd: 0, progress: noProgress },
    ];
    expect(detector().evaluate(windowOf(within)).reasons).not.toContain('time_box');
  });

  it('a healthy window with progress raises no signal', () => {
    const events: StallEventInput[] = [
      { kind: 'subtask', at: at(0), subtaskId: 's', status: 'started' },
      turn(1, { progress: progressed, cost: 0.1 }),
      tool(1, { a: 1 }),
      turn(2, { progress: progressed }),
    ];
    expect(detector().evaluate(windowOf(events))).toEqual({
      stalled: false,
      reasons: [],
      severity: 'low',
    });
  });

  it('an empty window is not stalled', () => {
    expect(detector().evaluate(windowOf([]))).toEqual({
      stalled: false,
      reasons: [],
      severity: 'low',
    });
  });
});

describe('severity', () => {
  it('escalates with the number of concurrent reasons: one low, two medium, three or more high', () => {
    const loopAndQuiet: StallEventInput[] = [turn(0, { cost: 1 })];
    for (let i = 1; i <= 4; i++) loopAndQuiet.push(tool(0, { q: 1 }), turn(i, { cost: 1 }));
    const two = detector().evaluate(windowOf(loopAndQuiet));
    expect(two.reasons).toEqual(expect.arrayContaining(['tool_loop', 'budget_crawl']));
    expect(two.severity).toBe('medium');

    const three = detector().evaluate(
      windowOf([
        { kind: 'subtask', at: at(0), subtaskId: 'x', status: 'started' },
        ...loopAndQuiet,
        turn(9, { cost: 1, minute: 60 }),
      ]),
    );
    expect(three.reasons.length).toBeGreaterThanOrEqual(3);
    expect(three.severity).toBe('high');
  });

  it('a single reason is low severity', () => {
    const one = detector().evaluate(
      windowOf([turn(0), turn(1), turn(2), turn(3), turn(4), turn(5)]),
    );
    expect(one).toEqual({ stalled: true, reasons: ['no_progress'], severity: 'low' });
  });
});

describe('configuration', () => {
  it('config overrides change the thresholds', () => {
    const events = [turn(0), turn(1), turn(2)];
    expect(detector().evaluate(windowOf(events)).stalled).toBe(false);
    expect(
      detector({ ...THRESHOLDS, noProgressTurns: 3 }).evaluate(windowOf(events)).reasons,
    ).toEqual(['no_progress']);
  });

  it('per-persona overrides apply to that persona only and cannot erase a base threshold', () => {
    const base = new StallDetector({
      thresholds: THRESHOLDS,
      personaOverrides: { 'deep-specialist': { noProgressTurns: 30 }, mentor: { errorLoop: 2 } },
    });
    const events = Array.from({ length: 8 }, (_, i) => turn(i));
    expect(base.evaluate(windowOf(events)).reasons).toEqual(['no_progress']);
    expect(base.forPersona('deep-specialist').evaluate(windowOf(events)).stalled).toBe(false);
    expect(base.forPersona('deep-specialist').thresholds.errorLoop).toBe(THRESHOLDS.errorLoop);
    expect(base.forPersona('exposure').thresholds).toEqual(THRESHOLDS);
    expect(base.forPersona('mentor').thresholds.errorLoop).toBe(2);
  });
});

describe('window: dedup, rolling size and validation', () => {
  it('merges partial messages of one turn: no double counting of cost or progress', () => {
    const w = windowOf([
      turn(0, { cost: 0.2 }),
      turn(0, { cost: 0.4, progress: progressed }),
      turn(0, { cost: 0.3 }),
    ]);
    const turns = w.snapshot().filter((e) => e.kind === 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ costUsd: 0.4, progress: { evidence: 1 } });
  });

  it('a duplicate tool call (same turn and tool use id) is counted once', () => {
    const call = tool(0, { q: 1 });
    const w = windowOf([turn(0), call, call, call]);
    expect(w.snapshot().filter((e) => e.kind === 'tool')).toHaveLength(1);
    expect(detector().evaluate(w).reasons).not.toContain('tool_loop');
  });

  it('stores only the argument digest, never the raw payload', () => {
    const w = windowOf([turn(0), tool(0, { password: 'hunter2-very-secret', target: 'x' })]);
    const serialised = JSON.stringify(w.snapshot());
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('very-secret');
  });

  it('is a rolling window: the oldest events drop first', () => {
    const w = windowOf(
      Array.from({ length: 10 }, (_, i) => turn(i)),
      { maxEvents: 4 },
    );
    expect(w.snapshot().map((e) => (e.kind === 'turn' ? e.turnId : ''))).toEqual([
      'turn-6',
      'turn-7',
      'turn-8',
      'turn-9',
    ]);
  });

  it('rejects malformed events and bad window options (fail closed)', () => {
    const w = new StallWindow({ sessionId: 's' });
    expect(() => {
      w.push({
        kind: 'turn',
        turnId: 't',
        at: '2026-10-31 10:00',
        costUsd: 0,
        progress: noProgress,
      });
    }).toThrow(ValidationError);
    expect(() => {
      w.push({ kind: 'turn', turnId: 't', at: at(0), costUsd: -1, progress: noProgress });
    }).toThrow(ValidationError);
    expect(() => {
      w.push({
        kind: 'tool',
        turnId: 't',
        toolUseId: 'u',
        at: at(0),
        tool: 'x',
        args: {},
        outcome: 'maybe',
      } as unknown as StallEventInput);
    }).toThrow(ValidationError);
    expect(() => {
      w.push({
        kind: 'turn',
        turnId: 't',
        at: at(0),
        costUsd: 0,
        progress: noProgress,
        extra: 1,
      } as unknown as StallEventInput);
    }).toThrow(ValidationError);
    expect(() => new StallWindow({ sessionId: '' })).toThrow(ValidationError);
    expect(() => new StallWindow({ sessionId: 's', maxEvents: 0 })).toThrow(ValidationError);
    expect(() => new StallWindow({ sessionId: 's', maxEvents: 5_000 })).toThrow(ValidationError);
  });

  it('a timezone-offset timestamp is rejected: only UTC ISO-8601 is accepted', () => {
    const w = new StallWindow({ sessionId: 's' });
    expect(() => {
      w.push({
        kind: 'turn',
        turnId: 't',
        at: '2026-10-31T12:00:00.000+02:00',
        costUsd: 0,
        progress: noProgress,
      });
    }).toThrow(ValidationError);
  });
});

describe('observer', () => {
  it('reports every evaluation, and the signal it produced', () => {
    const seen: { sessionId: string; signal: StallSignal; durationMs: number }[] = [];
    const observer: StallObserver = { evaluated: (input) => seen.push(input) };
    const w = windowOf([turn(0), turn(1), turn(2), turn(3), turn(4), turn(5)]);
    const signal = detector(THRESHOLDS, observer).evaluate(w);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: 'sess-1', signal });
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('properties', () => {
  it('a window whose turns all make progress is never stalled, whatever the costs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 5, noNaN: true }), { minLength: 1, maxLength: 60 }),
        (costs) => {
          const events = costs.map((c, i) => turn(i, { cost: c, progress: progressed }));
          return !detector().evaluate(windowOf(events)).stalled;
        },
      ),
    );
  });
});
