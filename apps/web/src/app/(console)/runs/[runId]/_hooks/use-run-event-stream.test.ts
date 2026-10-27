// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backoffDelayMs,
  compareEventIds,
  type EventSourceLike,
  MAX_EVENT_CHARS,
  type RunEventStreamOptions,
  useRunEventStream,
} from './use-run-event-stream';

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, l: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, l);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  send(id: string, body: unknown, raw?: string): void {
    this.onmessage?.(
      new MessageEvent('message', { data: raw ?? JSON.stringify(body), lastEventId: id }),
    );
  }
  fail(fatal = false): void {
    if (fatal) this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

const ev = (seq: number, type = 'message.partial') => ({
  type,
  ts: '2026-01-01T00:00:00.000Z',
  seq,
  payload: { n: seq },
});
const last = (): FakeSource => {
  const source = FakeSource.all.at(-1);
  if (!source) throw new Error('no EventSource created');
  return source;
};

function setup(extra: RunEventStreamOptions = {}, runId = 'run-1') {
  return renderHook(
    ({ id }) =>
      useRunEventStream(id, {
        createEventSource: (url) => new FakeSource(url),
        random: () => 1,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 8000,
        ...extra,
      }),
    { initialProps: { id: runId } },
  );
}

beforeEach(() => {
  FakeSource.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useRunEventStream', () => {
  it('connects through the BFF path and delivers events in id order', async () => {
    const { result } = setup();
    expect(last().url).toBe('/api/stream/runs/run-1/events');
    expect(result.current.status).toBe('connecting');
    await act(async () => {
      last().open();
      last().send('1-0', ev(1));
      last().send('2-0', ev(2));
      last().send('10-0', ev(3));
      last().send('9-0', ev(99)); // out of order / replay: ignored
      await Promise.resolve();
    });
    expect(result.current.status).toBe('open');
    expect(result.current.events.map((e) => e.id)).toEqual(['1-0', '2-0', '10-0']);
    expect(result.current.lastEventId).toBe('10-0');
  });

  it('resumes from lastEventId after a disconnect without gaps or duplicates', async () => {
    const { result } = setup();
    await act(async () => {
      last().open();
      last().send('1-0', ev(1));
      last().send('2-0', ev(2));
      await Promise.resolve();
    });
    const first = last();
    act(() => {
      first.fail();
    });
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.events).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(last().url).toBe('/api/stream/runs/run-1/events?lastEventId=2-0');
    await act(async () => {
      last().open();
      last().send('2-0', ev(2)); // server replays the boundary event: deduplicated
      last().send('3-0', ev(3));
      await Promise.resolve();
    });
    expect(result.current.events.map((e) => e.id)).toEqual(['1-0', '2-0', '3-0']);
    expect(result.current.reconnects).toBe(1);
    expect(result.current.status).toBe('open');
  });

  it('backs off exponentially, capped, and resets after open', () => {
    const { result } = setup();
    for (const expected of [1000, 2000, 4000, 8000, 8000]) {
      const before = FakeSource.all.length;
      act(() => {
        last().fail();
      });
      act(() => {
        vi.advanceTimersByTime(expected - 1);
      });
      expect(FakeSource.all.length).toBe(before);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeSource.all.length).toBe(before + 1);
    }
    act(() => {
      last().open();
      last().fail();
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.reconnects).toBe(6);
  });

  it('computes jittered delays within [ceiling/2, ceiling]', () => {
    expect(backoffDelayMs(0, 1000, 30000, 0)).toBe(500);
    expect(backoffDelayMs(0, 1000, 30000, 1)).toBe(1000);
    expect(backoffDelayMs(10, 1000, 30000, 1)).toBe(30000);
    expect(backoffDelayMs(1000, 1000, 30000, 1)).toBe(30000);
  });

  it('drops the oldest events past the buffer and sets gap', async () => {
    const { result } = setup({ bufferSize: 3 });
    await act(async () => {
      last().open();
      for (let i = 1; i <= 5; i += 1) last().send(`${i}-0`, ev(i));
      await Promise.resolve();
    });
    expect(result.current.events.map((e) => e.id)).toEqual(['3-0', '4-0', '5-0']);
    expect(result.current.gap).toBe(true);
    expect(result.current.droppedEvents).toBe(2);
  });

  it('does not set gap while within the buffer', async () => {
    const { result } = setup({ bufferSize: 3 });
    await act(async () => {
      last().send('1-0', ev(1));
      await Promise.resolve();
    });
    expect(result.current.gap).toBe(false);
  });

  it('drops and counts malformed, oversized and id-less events', async () => {
    const { result } = setup();
    await act(async () => {
      last().open();
      last().send('1-0', null, 'not json');
      last().send('2-0', { type: 'Bad Type', ts: 'x', seq: -1, payload: {} });
      last().send('3-0', null, 'x'.repeat(MAX_EVENT_CHARS + 1));
      last().send('', ev(4));
      last().send('5-0', ev(5));
      await Promise.resolve();
    });
    expect(result.current.invalidEvents).toBe(4);
    expect(result.current.events.map((e) => e.id)).toEqual(['5-0']);
    expect(result.current.status).toBe('open');
  });

  it('sets truncated on a stream.truncated event, stops, and restarts clean on reconnect()', async () => {
    const log = vi.fn();
    const { result } = setup({ log });
    await act(async () => {
      last().open();
      last().send('1-0', ev(1));
      await Promise.resolve();
    });
    const first = last();
    await act(async () => {
      first.listeners.get('stream.truncated')?.(
        new MessageEvent('stream.truncated', {
          data: JSON.stringify(ev(0, 'stream.truncated')),
          lastEventId: '',
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe('truncated');
    expect(first.closed).toBe(true);
    expect(log).toHaveBeenCalledWith('sse_truncated', { runId: 'run-1', lastEventId: '1-0' });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSource.all).toHaveLength(1); // no reconnect storm
    act(() => {
      result.current.reconnect();
    });
    expect(last().url).toBe('/api/stream/runs/run-1/events');
    expect(result.current.events).toHaveLength(0);
    expect(result.current.lastEventId).toBeUndefined();
  });

  it('maps a fatal HTTP 409 to truncated, 403/404 to closed+forbidden, others to retry', async () => {
    for (const [code, status, forbidden] of [
      [409, 'truncated', false],
      [403, 'closed', true],
      [404, 'closed', true],
    ] as const) {
      FakeSource.all = [];
      const probe = vi.fn(() => Promise.resolve(code));
      const { result, unmount } = setup({ probe });
      await act(async () => {
        last().fail(true);
        await Promise.resolve();
      });
      expect(result.current.status).toBe(status);
      expect(result.current.forbidden).toBe(forbidden);
      expect(probe).toHaveBeenCalledWith('/api/stream/runs/run-1/events');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeSource.all).toHaveLength(1);
      unmount();
    }
    FakeSource.all = [];
    const { result } = setup({ probe: () => Promise.resolve(503) });
    await act(async () => {
      last().fail(true);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeSource.all).toHaveLength(2);
  });

  it('closes without reconnecting when the server ends the stream', async () => {
    const { result } = setup();
    await act(async () => {
      last().open();
      last().send('1-0', ev(1));
      last().listeners.get('stream.closed')?.(
        new MessageEvent('stream.closed', {
          data: JSON.stringify(ev(2, 'stream.closed')),
          lastEventId: '',
        }),
      );
      await Promise.resolve();
    });
    expect(result.current.status).toBe('closed');
    expect(result.current.events).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSource.all).toHaveLength(1);
  });

  it('passes kill events through like any other', async () => {
    const { result } = setup();
    await act(async () => {
      last().send('1-0', ev(1, 'kill.initiated'));
      last().send('2-0', ev(2, 'kill.completed'));
      await Promise.resolve();
    });
    expect(result.current.events.map((e) => e.event.type)).toEqual([
      'kill.initiated',
      'kill.completed',
    ]);
    expect(result.current.status).not.toBe('closed');
  });

  it('closes the connection and cancels timers on unmount', () => {
    const { unmount } = setup();
    const src = last();
    act(() => {
      src.fail();
    });
    unmount();
    expect(src.closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSource.all).toHaveLength(1);
    const { unmount: u2 } = setup();
    const src2 = last();
    u2();
    expect(src2.closed).toBe(true);
    expect(src2.onmessage).toBeNull();
  });

  it('closes the old connection and starts clean when runId changes', async () => {
    const { result, rerender } = setup();
    await act(async () => {
      last().send('1-0', ev(1));
      await Promise.resolve();
    });
    const old = last();
    rerender({ id: 'run-2' });
    expect(old.closed).toBe(true);
    expect(last().url).toBe('/api/stream/runs/run-2/events');
    expect(result.current.events).toHaveLength(0);
    expect(result.current.lastEventId).toBeUndefined();
  });

  it('url-encodes the run id', () => {
    setup({}, 'a/b?c');
    expect(last().url).toBe('/api/stream/runs/a%2Fb%3Fc/events');
  });
});

describe('compareEventIds', () => {
  it('orders numerically by ms then seq', () => {
    expect(compareEventIds('9-0', '10-0')).toBe(-1);
    expect(compareEventIds('10-1', '10-0')).toBe(1);
    expect(compareEventIds('10-0', '10-0')).toBe(0);
  });
});
