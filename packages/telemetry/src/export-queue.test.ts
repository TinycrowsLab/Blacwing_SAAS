import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DropOldestExportQueue, type ExportQueueOptions } from './export-queue.js';

type Done = (ok: boolean) => void;

function options(
  overrides: Partial<ExportQueueOptions<number>> & Pick<ExportQueueOptions<number>, 'exportBatch'>,
): ExportQueueOptions<number> {
  return {
    maxQueueSize: 4,
    maxBatchSize: 2,
    scheduledDelayMs: 100,
    baseBackoffMs: 1000,
    maxBackoffMs: 4000,
    onDropped: () => undefined,
    onExportError: () => undefined,
    ...overrides,
  };
}

describe('DropOldestExportQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the oldest items when full and reports the count (never grows past the bound)', () => {
    const dropped: number[] = [];
    const queue = new DropOldestExportQueue<number>(
      options({ exportBatch: () => undefined, onDropped: (count) => dropped.push(count) }),
    );
    for (let item = 1; item <= 6; item += 1) queue.enqueue(item);
    expect(queue.size).toBe(4);
    expect(dropped).toEqual([1, 1]);
  });

  it('exports the surviving items, newest kept, in batches of maxBatchSize', async () => {
    const batches: number[][] = [];
    const queue = new DropOldestExportQueue<number>(
      options({
        exportBatch: (batch, done: Done) => {
          batches.push([...batch]);
          done(true);
        },
      }),
    );
    for (let item = 1; item <= 6; item += 1) queue.enqueue(item);
    await queue.forceFlush();
    expect(batches).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(queue.size).toBe(0);
  });

  it('keeps a failed batch, reports the error and retries after an exponential backoff', async () => {
    let attempts = 0;
    const errors = vi.fn();
    const sent: number[][] = [];
    const queue = new DropOldestExportQueue<number>(
      options({
        exportBatch: (batch, done: Done) => {
          attempts += 1;
          if (attempts <= 2) {
            done(false);
            return;
          }
          sent.push([...batch]);
          done(true);
        },
        onExportError: errors,
      }),
    );
    queue.enqueue(1);
    queue.start();

    await vi.advanceTimersByTimeAsync(100); // first tick: fails, backoff 1000 ms
    expect(errors).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(1);

    await vi.advanceTimersByTimeAsync(500); // still inside the backoff window
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(600); // retry at 1100 ms: fails again, backoff 2000 ms
    expect(attempts).toBe(2);
    expect(errors).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2100); // third attempt succeeds
    expect(sent).toEqual([[1]]);
    expect(queue.size).toBe(0);
    await queue.shutdown();
  });

  it('caps the retry backoff at maxBackoffMs', async () => {
    const attempts: number[] = [];
    const queue = new DropOldestExportQueue<number>(
      options({
        baseBackoffMs: 1000,
        maxBackoffMs: 1000,
        exportBatch: (_batch, done: Done) => {
          attempts.push(Date.now());
          done(false);
        },
      }),
    );
    queue.enqueue(1);
    queue.start();
    await vi.advanceTimersByTimeAsync(5500);
    const gaps = attempts.slice(1).map((time, index) => time - (attempts[index] ?? 0));
    expect(gaps.length).toBeGreaterThan(1);
    expect(gaps.every((gap) => gap === 1000)).toBe(true);
    await queue.shutdown().catch(() => undefined);
  });

  it('treats a synchronous exporter exception as a failed export', async () => {
    const errors = vi.fn();
    const queue = new DropOldestExportQueue<number>(
      options({
        exportBatch: () => {
          throw new Error('exporter broke');
        },
        onExportError: errors,
      }),
    );
    queue.enqueue(7);
    await queue.forceFlush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(1);
  });

  it('stops forceFlush at the first failed batch instead of spinning', async () => {
    const exportBatch = vi.fn((_batch: number[], done: Done) => {
      done(false);
    });
    const queue = new DropOldestExportQueue<number>(options({ exportBatch }));
    for (let item = 1; item <= 4; item += 1) queue.enqueue(item);
    await queue.forceFlush();
    expect(exportBatch).toHaveBeenCalledTimes(1);
  });

  it('refuses new items after shutdown and stops the timer', async () => {
    const exportBatch = vi.fn((_batch: number[], done: Done) => {
      done(true);
    });
    const queue = new DropOldestExportQueue<number>(options({ exportBatch }));
    queue.start();
    await queue.shutdown();
    queue.enqueue(1);
    queue.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.size).toBe(0);
    expect(exportBatch).not.toHaveBeenCalled();
  });

  it('does not start twice', () => {
    const queue = new DropOldestExportQueue<number>(options({ exportBatch: () => undefined }));
    queue.start();
    queue.start();
    expect(vi.getTimerCount()).toBe(1);
    void queue.shutdown();
  });
});
