/** Workspace package name of this package. */
export const name = '@blackwing/events';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  DropOldestBuffer,
  type GapMarker,
  type StreamEvent,
  type SubscriptionItem,
  type TruncatedMarker,
} from './buffer.js';
export { compareStreamIds, parseStreamId, runEventsKey, type StreamId } from './keys.js';
export {
  type ConsumeOptions,
  createEventBus,
  DEFAULT_BATCH_SIZE,
  DEFAULT_BLOCK_MS,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_STREAM_MAXLEN,
  DEFAULT_STREAM_TTL_SECONDS,
  DEFAULT_SUBSCRIBER_BUFFER,
  type EventBus,
  type EventBusMetrics,
  type EventBusOptions,
  type GroupEvent,
  type SubscribeOptions,
} from './stream.js';
