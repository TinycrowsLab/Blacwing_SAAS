// The transactional outbox writer (F12, F34, CONTEXT_PACK §7, §8.6, §8.8). `withOutbox` inserts
// side-effect intents (audit events, notifications, workflow signals) inside the CALLER'S
// transaction, so they commit or roll back together with the domain write: at-least-once delivery
// without a dual-write race. It never opens a connection of its own; the relay that dispatches the
// rows is WORKFLOW-012.
//
// Fail closed:
//   - no active `app.tenant_id` (or a malformed one)  -> TenantContextMissingError, nothing written
//   - invalid message / oversized payload             -> ValidationError, nothing written
//   - duplicate (tenant, dedupe_key)                  -> OutboxDuplicateError (the caller's tx is
//     aborted by Postgres, so the domain write rolls back with it)
// The row's tenant is the transaction's tenant, never a caller-supplied value, and RLS WITH CHECK
// (`outbox_tenant_isolation`) backs that up in the database.

import { sql } from 'drizzle-orm';

import {
  type OutboxMessage,
  type OutboxMessageInput,
  type OutboxMessageType,
  outboxMessagesSchema,
  outboxPayloadBytes,
  OUTBOX_PAYLOAD_MAX_BYTES,
} from '@blackwing/contracts';
import { ConflictError, TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import {
  createLogger,
  isSensitiveKey,
  type Logger,
  REDACTED,
  redactText,
  withContext,
} from '@blackwing/logger';

import { toTenantIsolationError } from './rls.js';
import { OUTBOX_DEDUPE_INDEX, outbox, type NewOutboxRow } from './schema/outbox.js';
import { type TenantTx, unwrapQueryError } from './with-tenant.js';

/** Counter hooks (OBS wires these to Prometheus; the default is a no-op). */
export interface OutboxMetrics {
  /** `outbox_rows_written_total{type}`: rows inserted by `withOutbox` (counted when the insert succeeds). */
  rowsWritten(type: OutboxMessageType, count: number): void;
}

const NOOP_METRICS: OutboxMetrics = { rowsWritten: () => undefined };

/** Options for {@link withOutbox}. */
export interface WithOutboxOptions {
  readonly logger?: Logger;
  readonly metrics?: OutboxMetrics;
}

/** `CONFLICT` (409): a message with this `dedupeKey` was already enqueued for the tenant. */
export class OutboxDuplicateError extends ConflictError {
  /** The repeated key (an idempotency key, not a secret). */
  readonly dedupeKey: string | undefined;

  constructor(dedupeKey?: string, options: { readonly cause?: unknown } = {}) {
    super('outbox dedupe key already used for this tenant', options);
    this.dedupeKey = dedupeKey;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';
const MAX_ISSUES_IN_DETAIL = 5;

let defaultLogger: Logger | undefined;

/** The package logger, created on first use so importing this module needs no configuration. */
function packageLogger(): Logger {
  defaultLogger ??= createLogger('@blackwing/db');
  return defaultLogger;
}

/** The transaction's tenant, or a fail-closed error. Outside a transaction `SET LOCAL` has no effect. */
async function activeTenantId(tx: TenantTx): Promise<string> {
  const result = await tx.execute<{ tenant_id: string | null }>(
    sql`SELECT current_setting('app.tenant_id', true) AS tenant_id`,
  );
  const value = result.rows[0]?.tenant_id;
  // An unset custom setting reads as NULL, and as '' once a previous transaction has set it.
  if (value === undefined || value === null || value === '') {
    throw new TenantContextMissingError('outbox write requires an active tenant context');
  }
  if (!UUID.test(value)) {
    throw new TenantContextMissingError('tenant context is not a valid tenant id');
  }
  return value.toLowerCase();
}

/** Zod issues as `path: message` lines. Never includes the offending value (payloads may be sensitive). */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, MAX_ISSUES_IN_DETAIL)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Safety-net redaction (§8.7) of a payload before it is stored: values under secret-looking keys
 * (`password`, `token`, `apiKey`, ...) at any depth and secret shapes inside strings (registered
 * values, `bwk_`/`bw_pat_`/`bw_ci_` tokens, bearer values, URL userinfo, PEM keys). Producers pass
 * references and redact first; the ledger and the queue are durable, so a leak here is permanent.
 */
function redact(value: unknown, counter: { count: number }): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value);
    if (redacted !== value) counter.count += 1;
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, counter));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        counter.count += 1;
        result[key] = REDACTED;
      } else {
        result[key] = redact(item, counter);
      }
    }
    return result;
  }
  return value;
}

/** Maps a failed insert to a typed error, looking through Drizzle's query-error wrapper. */
function toOutboxError(error: unknown, dedupeKeys: readonly string[]): Error {
  const driverError = unwrapQueryError(error);
  const { code, constraint } = driverError as { code?: unknown; constraint?: unknown };
  if (code === UNIQUE_VIOLATION && constraint === OUTBOX_DEDUPE_INDEX) {
    return new OutboxDuplicateError(dedupeKeys.length === 1 ? dedupeKeys[0] : undefined, {
      cause: error,
    });
  }
  const isolation = toTenantIsolationError(driverError);
  if (isolation !== undefined) return isolation;
  return error instanceof Error ? error : new Error('outbox insert failed', { cause: error });
}

/** Rejects a batch that repeats a dedupe key: Postgres would abort the whole transaction on it. */
function assertUniqueKeys(messages: readonly OutboxMessage[]): void {
  const seen = new Set<string>();
  for (const { dedupeKey } of messages) {
    if (dedupeKey === undefined) continue;
    if (seen.has(dedupeKey)) throw new OutboxDuplicateError(dedupeKey);
    seen.add(dedupeKey);
  }
}

/**
 * Enqueues `messages` as `pending` outbox rows inside `tx`, the same transaction as the domain
 * write, and returns their ids in input order. Pass the `tx` that `withTenant` hands to its callback:
 * a second connection would lose atomicity, so none is ever opened.
 *
 * `available_at` and `created_at` come from the database clock only. An empty list still requires
 * the tenant context and writes nothing.
 */
export async function withOutbox(
  tx: TenantTx,
  messages: readonly OutboxMessageInput[],
  options: WithOutboxOptions = {},
): Promise<readonly string[]> {
  const tenantId = await activeTenantId(tx);
  const parsed = outboxMessagesSchema.safeParse(messages);
  if (!parsed.success) {
    throw new ValidationError('invalid outbox message', {
      detail: describeIssues(parsed.error.issues),
    });
  }
  if (parsed.data.length === 0) return [];
  assertUniqueKeys(parsed.data);

  const entries = parsed.data.map((message) => {
    const counter = { count: 0 };
    const payload = redact(message.payload, counter) as OutboxMessage['payload'];
    // '[REDACTED]' can be longer than the value it replaces, so the cap is re-checked.
    if (outboxPayloadBytes(payload) > OUTBOX_PAYLOAD_MAX_BYTES) {
      throw new ValidationError('invalid outbox message', {
        detail: `payload: exceeds ${OUTBOX_PAYLOAD_MAX_BYTES} bytes after redaction: store the body in object storage and enqueue a payloadRef`,
      });
    }
    const row: NewOutboxRow & { id: string } = {
      id: newId(),
      tenantId,
      type: message.type,
      aggregateType: message.aggregateType ?? null,
      aggregateId: message.aggregateId ?? null,
      payload,
      dedupeKey: message.dedupeKey ?? null,
    };
    return { row, redacted: counter.count > 0 };
  });

  try {
    await tx.insert(outbox).values(entries.map((entry) => entry.row));
  } catch (error) {
    throw toOutboxError(
      error,
      parsed.data.flatMap((message) =>
        message.dedupeKey === undefined ? [] : [message.dedupeKey],
      ),
    );
  }

  const logger = withContext(options.logger ?? packageLogger(), { tenantId });
  const metrics = options.metrics ?? NOOP_METRICS;
  const perType = new Map<OutboxMessageType, number>();
  for (const { row, redacted } of entries) {
    logger.info(
      { outboxId: row.id, type: row.type, dedupeKey: row.dedupeKey, redacted },
      'outbox.insert',
    );
    perType.set(row.type, (perType.get(row.type) ?? 0) + 1);
  }
  for (const [type, count] of perType) metrics.rowsWritten(type, count);
  return entries.map((entry) => entry.row.id);
}
