import type { RunEvent } from '@blackwing/contracts';

/** An event with its stream id. */
export interface StreamEvent {
  readonly kind: 'event';
  readonly id: string;
  readonly event: RunEvent;
}

/**
 * The subscriber fell behind and the oldest buffered events were dropped. `fromId` and `toId` are
 * the first and last dropped stream ids; the client may refetch the range from the API.
 */
export interface GapMarker {
  readonly kind: 'gap';
  readonly dropped: number;
  readonly fromId: string;
  readonly toId: string;
}

/**
 * The cursor points at events that are no longer in the stream (trimmed away, or the stream was
 * lost, for example after a Valkey restart). The client does a full refetch from the API.
 */
export interface TruncatedMarker {
  readonly kind: 'truncated';
  readonly reason: 'trimmed' | 'stream_missing';
  readonly requestedId: string;
}

export type SubscriptionItem = StreamEvent | GapMarker | TruncatedMarker;

/**
 * A bounded FIFO of events with drop-oldest overflow (backpressure, requirement 6). Dropped events
 * are summarised in a single gap marker that is delivered before the surviving events, so memory is
 * bounded by `capacity` whatever the producer does. Truncation markers are never dropped.
 */
export class DropOldestBuffer {
  readonly #capacity: number;
  readonly #events: StreamEvent[] = [];
  readonly #markers: TruncatedMarker[] = [];
  #gap: { dropped: number; fromId: string; toId: string } | undefined;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('buffer capacity must be a positive integer');
    }
    this.#capacity = capacity;
  }

  /** Buffered events (markers excluded). */
  get size(): number {
    return this.#events.length;
  }

  /** Total number of events dropped over the buffer's lifetime. */
  droppedTotal = 0;

  pushMarker(marker: TruncatedMarker): void {
    this.#markers.push(marker);
  }

  push(item: StreamEvent): void {
    this.#events.push(item);
    while (this.#events.length > this.#capacity) {
      const dropped = this.#events.shift();
      if (dropped === undefined) break;
      this.droppedTotal += 1;
      this.#gap =
        this.#gap === undefined
          ? { dropped: 1, fromId: dropped.id, toId: dropped.id }
          : { dropped: this.#gap.dropped + 1, fromId: this.#gap.fromId, toId: dropped.id };
    }
  }

  /** Next item in delivery order: truncation markers, then the gap marker, then events. */
  shift(): SubscriptionItem | undefined {
    const marker = this.#markers.shift();
    if (marker !== undefined) return marker;
    if (this.#gap !== undefined) {
      const gap = this.#gap;
      this.#gap = undefined;
      return { kind: 'gap', ...gap };
    }
    return this.#events.shift();
  }

  get isEmpty(): boolean {
    return this.#markers.length === 0 && this.#gap === undefined && this.#events.length === 0;
  }
}
