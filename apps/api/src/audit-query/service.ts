import { trace } from '@opentelemetry/api';

import { hasPermission } from '@blackwing/domain';
import { ForbiddenError, TenantContextMissingError } from '@blackwing/errors';

import { filterSignature, invalidAuditCursor, parseAuditEventsQuery } from './query.js';

import type { AuditQueryMetrics } from './metrics.js';
import type {
  AuditEventPosition,
  AuditEventRecord,
  AuditQueryPrincipal,
  AuditQueryStore,
} from './ports.js';
import type { CursorCodec, CursorPayload } from '../pagination/cursor.js';
import type {
  AuditActor,
  AuditMetadata,
  AuditMetadataRef,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
} from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

/** The permission every audit read needs (RBAC catalogue: auditor and org admin). */
export const AUDIT_READ_PERMISSION = 'audit:read';
/** The role that may read chain fields and unredacted metadata (#86 requirement 4). */
export const AUDITOR_ROLE = 'auditor';
/** Milliseconds per second: `performance.now()` is in ms, latencies are reported in seconds. */
const MS_PER_SECOND = 1000;
/** The only cursor direction: newest first. */
const CURSOR_DIRECTION = 'desc';

/** One ledger row as the API returns it. `ip` and `userAgent` are never returned (PII minimised). */
export interface AuditEventView {
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly severity: AuditSeverity;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly outcome: AuditOutcome;
  readonly reason: string | null;
  readonly metadata: AuditMetadata;
  readonly metadataRef?: AuditMetadataRef;
  readonly traceId: string | null;
  readonly runId: string | null;
  /** Hex SHA-256 chain hash; only with `includeChain=true` for an auditor. */
  readonly hash?: string;
  /** Hex previous-row hash, `null` on the genesis row; only with `includeChain=true` for an auditor. */
  readonly prevHash?: string | null;
}

/** `GET /v1/audit/events` answer: one page, and the cursor for the next when there is one. */
export interface AuditEventsPage {
  readonly items: readonly AuditEventView[];
  readonly nextCursor?: string;
}

export interface AuditQueryServiceDeps {
  readonly store: AuditQueryStore;
  readonly codec: CursorCodec;
  readonly metrics: AuditQueryMetrics;
  readonly logger?: Pick<Logger, 'info'>;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Removes the actor's email for callers that are not auditors (PII minimised). */
function minimiseActor(actor: AuditActor): AuditActor {
  if (actor.type !== 'user' && actor.type !== 'operator') return actor;
  const copy = { ...actor };
  delete copy.email;
  return copy;
}

function project(
  record: AuditEventRecord,
  access: { readonly auditor: boolean; readonly includeChain: boolean },
): AuditEventView {
  const base = {
    id: record.id,
    seq: record.seq,
    occurredAt: record.occurredAt.toISOString(),
    action: record.action,
    severity: record.severity,
    actor: access.auditor ? record.actor : minimiseActor(record.actor),
    target: record.target,
    outcome: record.outcome,
    reason: record.reason,
    metadata: access.auditor ? record.metadata : {},
    traceId: record.traceId,
    runId: record.runId,
  };
  const withRef =
    access.auditor && record.metadataRef !== null
      ? { ...base, metadataRef: record.metadataRef }
      : base;
  if (!access.includeChain) return withRef;
  return {
    ...withRef,
    hash: toHex(record.hash),
    prevHash: record.prevHash === null ? null : toHex(record.prevHash),
  };
}

/**
 * The audit query service (#86). Checks run before any data is read, in this order: tenant context
 * (fail closed), `audit:read` (RBAC), query validation, `includeChain` needs the auditor role. The read
 * and the `audit.queried` record run in one tenant transaction, so a query that cannot be recorded
 * returns nothing.
 */
export class AuditQueryService {
  readonly #deps: AuditQueryServiceDeps;

  constructor(deps: AuditQueryServiceDeps) {
    this.#deps = deps;
  }

  async list(principal: AuditQueryPrincipal, rawQuery: unknown): Promise<AuditEventsPage> {
    const tenantId = principal.tenantId;
    if (tenantId === null)
      throw new TenantContextMissingError('no tenant context for the audit query');
    if (!hasPermission(principal.roles, AUDIT_READ_PERMISSION)) {
      throw new ForbiddenError('audit:read is required to query the audit ledger');
    }
    const query = parseAuditEventsQuery(rawQuery);
    const auditor = principal.roles.includes(AUDITOR_ROLE);
    if (query.includeChain && !auditor) {
      throw new ForbiddenError('includeChain requires the auditor role');
    }
    const signature = filterSignature(query.filters);
    const before =
      query.cursor === undefined ? undefined : this.#decodeCursor(query.cursor, signature);
    const filterKeys = Object.keys(query.filters).sort();
    const role = auditor
      ? AUDITOR_ROLE
      : principal.roles.includes('org_admin')
        ? 'org_admin'
        : 'other';
    const started = performance.now();

    return trace.getTracer('blackwing-api').startActiveSpan('audit.query', async (span) => {
      try {
        const { page, hasMore, returned } = await this.#deps.store.withTenant(
          tenantId,
          async (tx) => {
            const fetched = await tx.events.list({
              filters: query.filters,
              ...(before === undefined ? {} : { before }),
              fetchLimit: query.limit + 1,
            });
            const hasMore = fetched.length > query.limit;
            const page = hasMore ? fetched.slice(0, query.limit) : fetched;
            await tx.audit.queried({
              tenantId,
              action: 'audit.queried',
              actor: {
                type: principal.type,
                id: principal.id,
                ...(principal.tokenId === undefined ? {} : { tokenId: principal.tokenId }),
              },
              target: { type: 'tenant', id: tenantId },
              outcome: 'success',
              metadata: {
                filterKeys,
                limit: query.limit,
                returned: page.length,
                includeChain: query.includeChain,
              },
            });
            return { page, hasMore, returned: page.length };
          },
        );
        const last = page.at(-1);
        const nextCursor =
          hasMore && last !== undefined
            ? this.#deps.codec.encode({
                k: [last.occurredAt.toISOString(), last.seq],
                d: CURSOR_DIRECTION,
                s: signature,
              })
            : undefined;
        this.#deps.metrics.record({
          role,
          latencySeconds: (performance.now() - started) / MS_PER_SECOND,
        });
        this.#deps.logger?.info(
          { tenantId, actor: principal.id, filterKeys, returned },
          'audit.query',
        );
        return {
          items: page.map((record) =>
            project(record, { auditor, includeChain: query.includeChain }),
          ),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        };
      } finally {
        span.end();
      }
    });
  }

  /** Verifies the cursor (HMAC, version, direction, filters) and reads its position. Every failure is `INVALID_CURSOR`. */
  #decodeCursor(token: string, signature: string): AuditEventPosition {
    let payload: CursorPayload;
    try {
      payload = this.#deps.codec.decode(token, { d: CURSOR_DIRECTION, s: signature });
    } catch {
      throw invalidAuditCursor();
    }
    const [occurred, seq] = payload.k;
    if (
      payload.k.length !== 2 ||
      typeof occurred !== 'string' ||
      Number.isNaN(Date.parse(occurred)) ||
      typeof seq !== 'number' ||
      !Number.isInteger(seq) ||
      seq < 1
    ) {
      throw invalidAuditCursor();
    }
    return { occurredAt: new Date(occurred), seq };
  }
}
