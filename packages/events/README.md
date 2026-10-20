# @blackwing/events

Redis Streams (Valkey) helper for **live run events** (WORKFLOW-013, F12): the transport behind the
console live-run view. It is ephemeral. The durable record is the audit ledger and the evidence store.

```ts
import { createEventBus } from '@blackwing/events';

const bus = createEventBus({ redis, tenantId }); // one bus per tenant
const id = await bus.publish(runId, { type: 'message.partial', ts, seq: 1, payload: {} });

for await (const item of bus.subscribe(runId, { fromId: lastSeenId })) {
  // item.kind: 'event' | 'gap' | 'truncated'
}
```

| Concern | Behaviour |
|---|---|
| Key | `bw:{tenantId}:run:{runId}:events`. Ids are `[A-Za-z0-9_-]{1,64}`; anything else is refused, so a caller cannot escape the tenant or run scope (§8.6). A missing tenant fails closed. |
| Publish | Event validated with `runEventSchema` (`@blackwing/contracts`), capped at 32 KiB serialised (`maxEventBytes`; pass large blobs by evidence reference), `XADD MAXLEN ~ maxLen` (default 10000), TTL refreshed on every publish (default one day). `seq` is the publisher's; consumers sort by stream id. |
| Subscribe | `fromId`: `'$'` (default) only new, `'0'` from the start, or the last seen id to resume with no gaps and no duplicates. Each subscriber owns a dedicated blocking connection (`redis.duplicate()`), released on `return()`, `break` or abort. Read errors reconnect and resume from the last id. |
| Backpressure | Per-subscriber buffer (`bufferSize`, default 1000), drop-oldest, with one `gap` marker (`dropped`, `fromId`, `toId`) delivered before the surviving events. |
| Truncation | A cursor older than the oldest retained entry (trimmed, or the stream was lost and recreated) yields a `truncated` marker (`reason: 'trimmed' \| 'stream_missing'`): the client does a full refetch from the API. A lost stream is then re-read from the start. It can over-report by one when the cursor itself was the last entry trimmed. |
| Consumer groups | `consume(runId, { group, consumer })` is at-least-once: the consumer's pending entries are redelivered first, then new ones; call `event.ack()` after handling. `NOGROUP` (stream lost) recreates the group. |
| Retention | `trim(runId, { maxLen })` (exact), `expire(runId, seconds)`, `remove(runId)`. |
| Observability | `EventBusMetrics` hooks (`run_events_published_total{type}`, `run_event_stream_len{runId}`, `run_event_subscriber_lag`), `events.publish` span, logs carry `{tenantId, runId}` and never the payload. |

Integration tests (`pnpm --filter @blackwing/events test:int`) start Valkey through Testcontainers.
