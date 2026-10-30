import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import {
  type PlannedTestCase,
  type TestCasePatchBody,
  testCaseCreateBodySchema,
  testCasePatchBodySchema,
  TEST_PLAN_PAYLOAD_MAX_BYTES,
  type TestCaseView,
  type TestPlanPage,
  type TestPlanSummary,
  type TestPlanView,
  testPlanListQuerySchema,
  type TestPlanListQuery,
  type Permission,
} from '@blackwing/contracts';
import { ConcurrencyError, type TestCaseRow, type TestPlanRow } from '@blackwing/db';
import { hashTenantId } from '@blackwing/db/tenant-context';
import {
  AppError,
  EtagMismatchError,
  InternalError,
  PlanPayloadTooLargeError,
  PlanVersionImmutableError,
  TestCaseNotFoundError,
  TestPlanNotFoundError,
  ValidationError,
} from '@blackwing/errors';

import { rolesWithPermission, type TestPlanPrincipal } from './authorise.js';
import { computeEtag, requireIfMatch } from '../concurrency/index.js';
import { invalidCursor } from '../pagination/index.js';

import type { TestPlanMetrics, TestPlanMutation } from './metrics.js';
import type { TestPlanMemberships, TestPlanStore } from './ports.js';
import type { Logger } from '@blackwing/logger';

export type { TestPlanPrincipal } from './authorise.js';

const TRACER_NAME = '@blackwing/api/test-plans';
/** Attempts at creating the next version when a concurrent writer takes the same number first. */
const MAX_VERSION_ATTEMPTS = 3;
const JSON_PAYLOAD_FIELDS = ['targets', 'budget', 'oracle', 'negativeControl'] as const;

/** A plan or case answer with the ETag that validates it. */
export interface Versioned<T> {
  readonly body: T;
  readonly etag: string;
}

export interface TestPlanServiceDeps {
  readonly store: TestPlanStore;
  readonly memberships: TestPlanMemberships;
  readonly metrics: TestPlanMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
}

const MAX_VERSION = 2_147_483_647;
const versionSchema = z.coerce.number().int().min(1).max(MAX_VERSION);

/** Parses a request value at the boundary; a failure names the offending fields, never their values. */
function parseRequest<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}

/** A plan version validator: the row's `updated_at` (its state) and identity. A case edit moves it too. */
function planEtag(plan: TestPlanRow): string {
  return computeEtag({
    planId: plan.id,
    version: plan.version,
    status: plan.status,
    updatedAt: plan.updatedAt.toISOString(),
  });
}

/** A case validator: its identity, status and `updated_at`. */
function caseEtag(testCase: TestCaseRow): string {
  return computeEtag({
    caseId: testCase.id,
    status: testCase.status,
    updatedAt: testCase.updatedAt.toISOString(),
  });
}

function planSummary(plan: TestPlanRow): TestPlanSummary {
  return {
    planId: plan.id,
    runId: plan.runId,
    version: plan.version,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

function caseView(testCase: TestCaseRow): TestCaseView {
  return {
    caseId: testCase.id,
    planId: testCase.testPlanId,
    class: testCase.class,
    title: testCase.title,
    status: testCase.status,
    statusReason: testCase.statusReason,
    refs: { owasp: testCase.owaspRefs, wstg: testCase.wstgRefs, asvs: testCase.asvsRefs },
    cweCandidates: testCase.cweCandidates,
    targets: testCase.targets as string[],
    roles: testCase.roles,
    budget: testCase.budget,
    oracle: testCase.oracle,
    negativeControl: testCase.negativeControl,
    createdAt: testCase.createdAt.toISOString(),
    updatedAt: testCase.updatedAt.toISOString(),
  } as TestCaseView;
}

/**
 * The planned-case shape of a stored case, to copy it into the next version (removed cases are not copied).
 * Every case the API writes declares its oracle (§8.11), so a stored case without one is a broken row: fail closed.
 */
function plannedOf(testCase: TestCaseRow): PlannedTestCase {
  if (testCase.oracle === null) {
    throw new InternalError('stored test case has no oracle', {
      detail: 'A test case must declare its oracle.',
    });
  }
  return {
    class: testCase.class,
    title: testCase.title,
    refs: { owasp: testCase.owaspRefs, wstg: testCase.wstgRefs, asvs: testCase.asvsRefs },
    cweCandidates: testCase.cweCandidates,
    targets: testCase.targets as string[],
    roles: testCase.roles,
    budget: testCase.budget,
    oracle: testCase.oracle,
    negativeControl: testCase.negativeControl,
  } as PlannedTestCase;
}

/** Refuses a JSON payload over the 8 KiB ceiling (413). Only the field name and size reach the client. */
function assertPayloadSize(
  payload: Partial<Record<(typeof JSON_PAYLOAD_FIELDS)[number], unknown>>,
) {
  for (const field of JSON_PAYLOAD_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > TEST_PLAN_PAYLOAD_MAX_BYTES) {
      throw new PlanPayloadTooLargeError(
        `${field} is ${String(bytes)} bytes; the limit is ${String(TEST_PLAN_PAYLOAD_MAX_BYTES)} bytes.`,
      );
    }
  }
}

function encodeCursor(version: number): string {
  return Buffer.from(`v:${String(version)}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const match = /^v:(\d{1,10})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (match?.[1] === undefined) throw invalidCursor();
  return Number(match[1]);
}

/**
 * Test plan editing (PLAN-005): numbered versions of a run's plan, and the cases inside a draft version.
 * Reads need `testplan:read`; every change needs `testplan:edit` (AppSec Engineer). A version that is not a
 * draft is immutable: a change is `PLAN_VERSION_IMMUTABLE` and the client creates the next version.
 * Changes are guarded by `If-Match` (412 on a stale ETag, 428 when missing). Every committed write audits
 * itself in the store's transaction.
 */
export class TestPlanService {
  private readonly tracer: Tracer;

  constructor(private readonly deps: TestPlanServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /** Creates the next version of a run's plan, carrying over the cases of the newest one that are not removed. */
  async createVersion(
    principal: TestPlanPrincipal,
    runId: string,
  ): Promise<Versioned<TestPlanView>> {
    return this.inSpan('test-plans.create_version', async (span) => {
      await this.authorise(principal, 'testplan:edit');
      span.setAttribute('runId', runId);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const latest = await this.deps.store.findLatestVersion(runId);
          const cases = (latest?.cases ?? [])
            .filter((testCase) => testCase.status !== 'removed')
            .map((testCase) => plannedOf(testCase));
          const created = await this.deps.store.createVersion({
            runId,
            createdBy: principal.actorId,
            cases,
          });
          this.mutated('create_version', principal, {
            runId,
            planId: created.plan.id,
            version: created.plan.version,
          });
          return this.planView(created.plan, created.cases);
        } catch (error) {
          // A concurrent writer took this version number: recompute from the newest version and try again.
          if (error instanceof ConcurrencyError && attempt < MAX_VERSION_ATTEMPTS) continue;
          throw error;
        }
      }
    });
  }

  /** A page of a run's versions, oldest first, keyset on the version number. */
  async listVersions(
    principal: TestPlanPrincipal,
    runId: string,
    query: unknown,
  ): Promise<TestPlanPage> {
    return this.inSpan('test-plans.list_versions', async () => {
      await this.authorise(principal, 'testplan:read');
      const parsed: TestPlanListQuery = parseRequest(testPlanListQuerySchema, query, 'page query');
      const afterVersion = parsed.cursor === undefined ? undefined : decodeCursor(parsed.cursor);
      const rows = await this.deps.store.listVersions(runId, {
        ...(afterVersion === undefined ? {} : { afterVersion }),
        limit: parsed.limit + 1,
      });
      const items = rows.slice(0, parsed.limit).map((plan) => planSummary(plan));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > parsed.limit && last !== undefined ? encodeCursor(last.version) : null,
      };
    });
  }

  /** One version with its cases, and the ETag of that version. */
  async getVersion(
    principal: TestPlanPrincipal,
    runId: string,
    version: unknown,
  ): Promise<Versioned<TestPlanView>> {
    return this.inSpan('test-plans.get_version', async () => {
      await this.authorise(principal, 'testplan:read');
      const found = await this.deps.store.findVersion(
        runId,
        parseRequest(versionSchema, version, 'version'),
      );
      if (found === undefined) throw new TestPlanNotFoundError();
      return this.planView(found.plan, found.cases);
    });
  }

  /** Adds a case to a draft version. `If-Match` is the plan's ETag. */
  async addCase(
    principal: TestPlanPrincipal,
    planId: string,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<{ readonly case: Versioned<TestCaseView>; readonly planEtag: string }> {
    return this.inSpan('test-cases.create', async () => {
      await this.authorise(principal, 'testplan:edit');
      const values = parseRequest(testCaseCreateBodySchema, body, 'test case');
      assertPayloadSize(values);
      const current = await this.deps.store.findById(planId);
      if (current === undefined) throw new TestPlanNotFoundError();
      assertDraft(current.plan);
      requirePlanVersion(planEtag(current.plan), ifMatch);
      const written = await this.deps.store.addCase(planId, {
        actorId: principal.actorId,
        expectedUpdatedAt: current.plan.updatedAt,
        values,
      });
      this.mutated('add_case', principal, {
        runId: written.plan.runId,
        planId,
        version: written.plan.version,
        caseId: written.testCase.id,
      });
      return {
        case: { body: caseView(written.testCase), etag: caseEtag(written.testCase) },
        planEtag: planEtag(written.plan),
      };
    });
  }

  /** Edits a case of a draft version. `If-Match` is the case's ETag. */
  async updateCase(
    principal: TestPlanPrincipal,
    caseId: string,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<Versioned<TestCaseView>> {
    return this.inSpan('test-cases.patch', async () => {
      await this.authorise(principal, 'testplan:edit');
      const patch: TestCasePatchBody = parseRequest(
        testCasePatchBodySchema,
        body,
        'test case patch',
      );
      assertPayloadSize(patch);
      const current = await this.findLiveCase(caseId);
      assertDraft(current.plan);
      requirePlanVersion(caseEtag(current.testCase), ifMatch);
      const written = await this.deps.store.updateCase(caseId, {
        actorId: principal.actorId,
        expectedUpdatedAt: current.testCase.updatedAt,
        patch,
      });
      this.mutated('update_case', principal, {
        runId: written.plan.runId,
        planId: written.plan.id,
        version: written.plan.version,
        caseId,
      });
      return { body: caseView(written.testCase), etag: caseEtag(written.testCase) };
    });
  }

  /**
   * Soft-removes a case. Removing a case that is already removed answers 200 with the case and writes nothing,
   * so a retried DELETE is safe. Otherwise `If-Match` must name the case's current ETag.
   */
  async removeCase(
    principal: TestPlanPrincipal,
    caseId: string,
    ifMatch: string | undefined,
  ): Promise<Versioned<TestCaseView>> {
    return this.inSpan('test-cases.remove', async () => {
      await this.authorise(principal, 'testplan:edit');
      const current = await this.deps.store.findCase(caseId);
      if (current === undefined) throw new TestCaseNotFoundError();
      if (current.testCase.status === 'removed') {
        return { body: caseView(current.testCase), etag: caseEtag(current.testCase) };
      }
      assertDraft(current.plan);
      requirePlanVersion(caseEtag(current.testCase), ifMatch);
      const written = await this.deps.store.removeCase(caseId, {
        actorId: principal.actorId,
        expectedUpdatedAt: current.testCase.updatedAt,
      });
      if (written.changed) {
        this.mutated('remove_case', principal, {
          runId: written.plan.runId,
          planId: written.plan.id,
          version: written.plan.version,
          caseId,
        });
      }
      return { body: caseView(written.testCase), etag: caseEtag(written.testCase) };
    });
  }

  /** A case that exists and is not removed, with its plan. Otherwise `TEST_CASE_NOT_FOUND`. */
  private async findLiveCase(caseId: string) {
    const found = await this.deps.store.findCase(caseId);
    if (found === undefined || found.testCase.status === 'removed') {
      throw new TestCaseNotFoundError();
    }
    return found;
  }

  /** Reads need `testplan:read`, writes `testplan:edit`. No membership (or no roles) means no permission. */
  private async authorise(principal: TestPlanPrincipal, permission: Permission): Promise<void> {
    await rolesWithPermission(this.deps.memberships, principal, permission);
  }

  private planView(plan: TestPlanRow, cases: readonly TestCaseRow[]): Versioned<TestPlanView> {
    return {
      body: { ...planSummary(plan), cases: cases.map((testCase) => caseView(testCase)) },
      etag: planEtag(plan),
    };
  }

  private mutated(
    op: TestPlanMutation,
    principal: TestPlanPrincipal,
    ids: { runId: string; planId: string; version?: number; caseId?: string },
  ): void {
    this.deps.metrics.mutated(op);
    this.deps.logger.info(
      {
        tenantId: hashTenantId(principal.tenantId),
        actorId: principal.actorId,
        op,
        ...ids,
      },
      'test_plan.mutated',
    );
  }

  private async inSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/**
 * `If-Match` against the current ETag. A missing header is 428; a stale one is 412 with the stable code
 * `ETAG_MISMATCH` (the generic precondition code would not tell the client what to do).
 */
function requirePlanVersion(currentEtag: string, ifMatch: string | undefined): void {
  try {
    requireIfMatch(currentEtag, ifMatch);
  } catch (error) {
    if (error instanceof AppError && error.code === 'PRECONDITION_FAILED') {
      throw new EtagMismatchError({ cause: error });
    }
    throw error;
  }
}

/** A plan that is not a draft is immutable (`PLAN_VERSION_IMMUTABLE`). */
function assertDraft(plan: TestPlanRow): void {
  if (plan.status !== 'draft') throw new PlanVersionImmutableError();
}
