import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import {
  type FindingDetail,
  findingDetailSchema,
  type FindingListResponse,
  type FindingOccurrence,
  type FindingEvidenceRef,
  FINDING_DETAIL_INLINE_MAX,
  type FindingListFilters,
  findingSummarySchema,
  type FindingSummary,
  findingPublicIdSchema,
  type Permission,
  uuidV7Schema,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { toUuid } from '@blackwing/ids';

import { findingQuerySignature, type ParsedFindingListQuery } from './query.js';
import { type CursorCodec, invalidCursor } from '../pagination/index.js';

import type { FindingMetrics } from './metrics.js';
import type { FindingPolicyEngine, FindingPolicyResource } from './policy.js';
import type { FindingMemberships, FindingStore } from './ports.js';
import type { FindingOccurrenceRow, FindingRow } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/findings';
const SPAN_LIST = 'api.findings.list';
const SPAN_GET = 'api.findings.get';
const FINDING_ID_PREFIX = 'fnd';
const LIST_DIRECTION = 'desc';
const READ_PERMISSION: Permission = 'finding:read';
/** The collection-level probe: is the viewer allowed to read suspected findings at all? */
const COLLECTION_PROBE = '*';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface FindingPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface FindingServiceDeps {
  readonly store: FindingStore;
  readonly memberships: FindingMemberships;
  readonly policy: FindingPolicyEngine;
  readonly cursors: CursorCodec;
  readonly metrics: FindingMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
}

const uuidSchema = z.uuid();

/** One page of finding rows (the REST list maps them to summaries; GraphQL maps them to its types). */
export interface FindingPage {
  readonly rows: readonly FindingRow[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Keyset position of the last row of a page: its creation instant (millisecond precision) and id. */
interface Position {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Read service of the findings API (FINDING query, §9). It owns the authorisation of a read (RBAC `finding:read`,
 * then the Cedar resource rules, which hide Suspected findings from non-analysts, F17), the cursor and the wire
 * shape. A finding that is missing, foreign or hidden from the caller is the same `404`, so existence is not leaked.
 */
export class FindingService {
  private readonly tracer: Tracer;

  constructor(private readonly deps: FindingServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /** A page of findings of the caller's tenant, newest first, with the Suspected rule applied (REST and GraphQL). */
  async list(
    principal: FindingPrincipal,
    query: ParsedFindingListQuery,
  ): Promise<FindingListResponse> {
    return this.inSpan(SPAN_LIST, async () => {
      const page = await this.page(principal, query);
      return {
        items: page.rows.map((row) => summaryOf(row)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  /** The finding rows of one page, with the cursor of the next one. Authorised like {@link list}. */
  async page(principal: FindingPrincipal, query: ParsedFindingListQuery): Promise<FindingPage> {
    const roles = await this.requireRead(principal, 'list');
    const suspectedVisible = this.canSeeSuspected(principal, roles);
    const signature = findingQuerySignature(query.filters, suspectedVisible);
    // A status filter that only matches suspected findings is an empty page for a non-analyst (never an error).
    if (query.filters.status === 'suspected' && !suspectedVisible) {
      this.deps.metrics.request('list', 'ok');
      return { rows: [], nextCursor: null, hasMore: false };
    }
    const after = query.cursor === undefined ? undefined : this.positionOf(query.cursor, signature);
    const rows = await this.deps.store.search({
      ...this.filtersOf(query.filters),
      ...(suspectedVisible ? {} : { excludeStatuses: ['suspected' as const] }),
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    this.deps.metrics.request('list', 'ok');
    return {
      rows: page,
      nextCursor:
        hasMore && last !== undefined
          ? this.deps.cursors.encode({
              k: [last.createdAt.toISOString(), last.id],
              d: LIST_DIRECTION,
              s: signature,
            })
          : null,
      hasMore,
    };
  }

  /** One finding with its occurrences and evidence refs. Missing, foreign and hidden findings are one `404`. */
  async get(principal: FindingPrincipal, publicId: string): Promise<FindingDetail> {
    return this.inSpan(SPAN_GET, async () => {
      const row = await this.readable(principal, publicId);
      const occurrences = await this.deps.store.listOccurrences(row.id);
      this.deps.metrics.request('get', 'ok');
      return detailOf(row, occurrences);
    });
  }

  /**
   * One finding row the caller may read: RBAC, the id, the tenant and the Cedar rule, in that order. Missing, foreign
   * and hidden findings are the same `404`. Its occurrences are not read here (see {@link occurrencesOf}).
   */
  async readable(principal: FindingPrincipal, publicId: string): Promise<FindingRow> {
    const roles = await this.requireRead(principal, 'get');
    const row = await this.findOrNotFound(publicId);
    const resource: FindingPolicyResource = {
      id: row.publicId,
      tenantId: row.tenantId,
      status: row.status,
    };
    if (!this.deps.policy.allows(this.policyPrincipal(principal, roles), resource)) {
      this.deps.metrics.request('get', 'not_found');
      throw new NotFoundError('finding not found');
    }
    return row;
  }

  /** The occurrences of several findings in one read (the GraphQL batch). Callers must pass only visible findings. */
  async occurrencesOf(findingIds: readonly string[]): Promise<FindingOccurrenceRow[]> {
    return this.deps.store.listOccurrencesOf(findingIds);
  }

  /** Reads need `finding:read` in the tenant; a caller with no role there is refused (fail closed). */
  private async requireRead(
    principal: FindingPrincipal,
    route: 'list' | 'get',
  ): Promise<readonly string[]> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, READ_PERMISSION)) {
      this.deps.metrics.request(route, 'denied');
      throw new ForbiddenError('the caller may not read findings', {
        detail: `Missing permission ${READ_PERMISSION} in this tenant.`,
      });
    }
    return roles;
  }

  /** Whether the viewer may read suspected findings at all (the Cedar collection probe). */
  private canSeeSuspected(principal: FindingPrincipal, roles: readonly string[]): boolean {
    return this.deps.policy.allows(this.policyPrincipal(principal, roles), {
      id: COLLECTION_PROBE,
      tenantId: principal.tenantId,
      status: 'suspected',
    });
  }

  private policyPrincipal(principal: FindingPrincipal, roles: readonly string[]) {
    return { userId: principal.actorId, tenantId: principal.tenantId, roles };
  }

  private async rolesOf(principal: FindingPrincipal): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    return userId.success ? this.deps.memberships.rolesOf(principal.tenantId, userId.data) : [];
  }

  /** The finding named by a public id, or `404`. A malformed id and a missing row read the same. */
  private async findOrNotFound(publicId: string): Promise<FindingRow> {
    const parsed = findingPublicIdSchema.safeParse(publicId);
    if (!parsed.success) {
      this.deps.metrics.request('get', 'not_found');
      throw new NotFoundError('finding not found');
    }
    let uuid: string;
    try {
      uuid = toUuid(parsed.data, FINDING_ID_PREFIX);
    } catch {
      this.deps.metrics.request('get', 'not_found');
      throw new NotFoundError('finding not found');
    }
    const row = await this.deps.store.findById(uuid);
    if (row === undefined) {
      this.deps.metrics.request('get', 'not_found');
      throw new NotFoundError('finding not found');
    }
    return row;
  }

  /** Decodes a list cursor into the keyset position it names. Any tampering or mismatch is `invalid_cursor`. */
  private positionOf(token: string, signature: string): Position {
    let payload: ReturnType<CursorCodec['decode']>;
    try {
      payload = this.deps.cursors.decode(token, { d: LIST_DIRECTION, s: signature });
    } catch {
      throw invalidCursor();
    }
    const [at, id] = payload.k;
    if (payload.k.length !== 2 || typeof at !== 'string' || typeof id !== 'string') {
      throw invalidCursor();
    }
    const createdAt = new Date(at);
    if (Number.isNaN(createdAt.getTime()) || !uuidV7Schema.safeParse(id).success) {
      throw invalidCursor();
    }
    return { createdAt, id };
  }

  /** The filters as the store reads them: the parsed values, with the status and its exclusions kept apart. */
  private filtersOf(filters: FindingListFilters) {
    return {
      ...(filters.assetId === undefined ? {} : { assetId: filters.assetId }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.severity === undefined ? {} : { severity: filters.severity }),
      ...(filters.cwe === undefined ? {} : { cweId: filters.cwe }),
      ...(filters.owasp === undefined ? {} : { owaspCategory: filters.owasp }),
      ...(filters.baselineStatus === undefined ? {} : { baselineStatus: filters.baselineStatus }),
    };
  }

  private async inSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await fn(span);
      } catch (error) {
        if (!(error instanceof ForbiddenError) && !(error instanceof NotFoundError)) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/** A row as the list shows it. Every stored jsonb is re-validated against its contract before it leaves the API. */
export function summaryOf(row: FindingRow): FindingSummary {
  return findingSummarySchema.parse({
    id: row.publicId,
    title: row.title,
    class: row.class,
    status: row.status,
    baselineStatus: row.baselineStatus,
    severity: row.severity,
    cweId: row.cweId,
    owaspCategory: row.owaspCategory,
    unmapped: row.unmapped,
    confidence: row.confidence,
    assetId: row.assetId,
    location: row.location,
    firstSeenRunId: row.firstSeenRunId,
    lastSeenRunId: row.lastSeenRunId,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * The detail projection: the summary, the mapping, acceptance and release records, and the occurrences and evidence
 * refs. Both collections are bounded: the first {@link FINDING_DETAIL_INLINE_MAX} are inlined, and `total` and
 * `truncated` say how many there are. Evidence is referenced by its bound chain refs, never inlined.
 */
function detailOf(row: FindingRow, occurrences: readonly FindingOccurrenceRow[]): FindingDetail {
  const occurrenceItems: FindingOccurrence[] = occurrences
    .slice(0, FINDING_DETAIL_INLINE_MAX)
    .map((o) => ({
      id: o.id,
      runId: o.runId,
      occurrenceStatus: o.occurrenceStatus,
      evidenceChainHead: o.evidenceChainHead,
      detectedAt: o.detectedAt.toISOString(),
    }));
  const evidence = occurrences.flatMap((o) =>
    o.evidenceRefs.map((ref) => ({ ...ref, occurrenceId: o.id, runId: o.runId })),
  );
  const evidenceItems: FindingEvidenceRef[] = evidence.slice(0, FINDING_DETAIL_INLINE_MAX);
  return findingDetailSchema.parse({
    ...summaryOf(row),
    mappingVersion: row.mappingVersion,
    classification: row.classification,
    acceptedRisk: row.acceptedRisk,
    releasedBy: row.releasedBy,
    releasedAt: row.releasedAt === null ? null : row.releasedAt.toISOString(),
    occurrences: {
      items: occurrenceItems,
      total: occurrences.length,
      truncated: occurrences.length > occurrenceItems.length,
    },
    evidence: {
      items: evidenceItems,
      total: evidence.length,
      truncated: evidence.length > evidenceItems.length,
    },
  });
}
