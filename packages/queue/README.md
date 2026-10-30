# @blackwing/queue

BullMQ queue and worker factory on Valkey for **short, non-durable jobs** (email send, cache warm, webhook
delivery). Temporal owns durable orchestration; this package does not replace it. Issue #30, feature F12.

```ts
import { createQueue, createWorker } from '@blackwing/queue';

const email = createQueue('email-send', { tenantId, payload: emailJobSchema });
await email.add({ to: 'ops@example.test', template: 'run-complete' }, { jobId: `run-${runId}-complete` });

const worker = createWorker('email-send', async (payload) => sendMail(payload), {
  tenantId,
  payload: emailJobSchema,
});
// on shutdown: await worker.close();
```

| Concern | Behaviour |
|---|---|
| Connection | `REDIS_URL` through `@blackwing/config` (default `redis://valkey:6379`). `maxRetriesPerRequest: null` (BullMQ requires it for workers) and reconnects back off 200 ms per attempt, capped at 5 s. |
| Tenant scope | Required `tenantId` (uuid). Keys are `bw:<tenantId>:<queue>:...` (`BULL_PREFIX`, default `bw`), so one tenant's jobs are never visible to another tenant's worker (§8.6). Queue names are lowercase letters, digits and dashes only, so a name cannot escape the prefix. |
| Payloads | Zod-validated on enqueue (`VALIDATION_FAILED`) and again before a worker runs them. A payload that fails in the worker fails the job at once (`UnrecoverableError`, no retries). Serialised size is capped at 256 KiB (`QUEUE_PAYLOAD_TOO_LARGE`); pass large data by reference. Secrets are never payloads: pass secret references. |
| Retry | Default job options: `attempts: 5`, exponential backoff from 1 s, completed jobs kept one hour, failed jobs kept (`removeOnFail: false`). DLQ and replay are WORKFLOW-010. |
| Idempotency | `jobId` (1 to 128 letters, digits, `.`, `-`, `_`). A repeated `jobId` is a no-op. |
| Enqueue failure | Valkey unreachable or slow past `enqueueTimeoutMs` (5 s): `QUEUE_UNAVAILABLE` (503, retryable). The caller decides. |
| Concurrency | `BULL_WORKER_CONCURRENCY` (default 10, 1 to 256). |
| Metrics | `bull_jobs_completed_total{queue}`, `bull_jobs_failed_total{queue}` (QueueEvents listener, terminal failures only), gauges `bull_jobs_active{queue}`, `bull_jobs_waiting{queue}`, `bull_queue_depth{queue}` (waiting plus delayed), sampled every 15 s. |
| Observability | Span `bull.process` per attempt; logs carry `{component: 'bullmq', queue, jobId}` and never the payload. |
| Shutdown | `worker.close()` waits for running jobs, then closes its events, sampler and connections. It is idempotent. |

Integration tests (`pnpm --filter @blackwing/queue test:int`) start Valkey through Testcontainers.
