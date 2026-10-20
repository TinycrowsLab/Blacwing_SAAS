import {
  type KillEgressIdentity,
  type KillScope,
  killScopeSchema,
  type KillTargetSet,
  killTargetSetSchema,
  PLATFORM_OPERATOR,
  type RunState,
  TERMINAL_RUN_STATES,
  uuidV7Schema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

/**
 * Kill scope resolver (KILL-002, F33, CONTEXT_PACK §8.5).
 *
 * Given a kill scope and reference, works out every run, agent session, sandbox, virtual model key,
 * egress identity and Temporal workflow the kill must stop. It is read-only and has no side effects:
 * the propagation coordinator (KILL-004/005/006) acts on the returned set and the caller audits it.
 *
 * `@blackwing/domain` may not import `@blackwing/db` (docs/architecture/dependency-graph.md), so rows
 * come through the `KillTargetReader` port. The data-access adapter implements it on a `withTenant`
 * transaction (RLS) for a tenant context and on the platform-operator role for an operator context.
 * The resolver re-checks tenancy and state on every row it gets back, so a mis-scoped adapter cannot
 * widen a tenant kill across tenants (§8.6).
 */

/** Name of the span the caller wraps around `resolveKillTargets` (the resolver itself does no I/O). */
export const KILL_RESOLVE_SPAN = 'kill.resolve';

/** Who is resolving: a tenant (RLS-scoped) or the platform operator (the only path to `global`). */
export type KillResolveContext =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | {
      readonly kind: 'operator';
      /** Must be `platform_operator`; checked at run time because contexts cross service boundaries. */
      readonly role: string;
      readonly operatorId: string;
    };

/** One `runs` row as the resolver needs it. */
export interface KillRunRow {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
  /** Assets the run targets. */
  readonly assetIds: readonly string[];
  /** Temporal `AssessmentRunWorkflow` id, once the workflow has started. */
  readonly workflowId: string | null;
}

/** One `agent_sessions` row. Retries may produce several rows for the same `sessionId`. */
export interface KillSessionRow {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sandboxId: string | null;
  readonly virtualKeyId: string | null;
  /** Temporal child `AgentSessionWorkflow` id. */
  readonly workflowId: string | null;
  /** Test case and role the session's egress proxy principal encodes (§4.1), when it has one. */
  readonly testCaseId: string | null;
  readonly roleId: string | null;
}

/** One `subtasks` row: it may name a session or sandbox before its `agent_sessions` row exists. */
export interface KillSubtaskRow {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly sandboxId: string | null;
}

/** Which runs the reader should load. The resolver filters again, so the reader may over-fetch. */
export type KillRunQuery =
  | { readonly by: 'run'; readonly runId: string }
  | { readonly by: 'asset'; readonly assetId: string }
  | { readonly by: 'tenant'; readonly tenantId: string }
  | { readonly by: 'all' };

/**
 * The transaction-bound read port (the `tx` argument). `context` is the context the transaction was
 * opened with: a `withTenant` transaction carries its tenant, an operator transaction its operator.
 */
export interface KillTargetReader {
  readonly context: KillResolveContext;
  /** Runs matching `query` whose state is not in `excludeStates`. */
  listRuns(query: KillRunQuery, excludeStates: readonly RunState[]): Promise<readonly KillRunRow[]>;
  listSessions(runIds: readonly string[]): Promise<readonly KillSessionRow[]>;
  listSubtasks(runIds: readonly string[]): Promise<readonly KillSubtaskRow[]>;
}

/** Stable reasons carried on `KillResolveError.reason`. */
export const KILL_RESOLVE_REASONS = Object.freeze({
  globalRequiresOperator: 'kill.resolve.globalRequiresOperator',
  crossTenant: 'kill.resolve.crossTenant',
  invalidRef: 'kill.resolve.invalidRef',
  invalidContext: 'kill.resolve.invalidContext',
} as const);
export type KillResolveReason = (typeof KILL_RESOLVE_REASONS)[keyof typeof KILL_RESOLVE_REASONS];

/** A refused resolution: `FORBIDDEN` for a context violation, `VALIDATION_FAILED` for a bad ref. */
export class KillResolveError extends AppError {
  readonly reason: KillResolveReason;
  constructor(code: 'FORBIDDEN' | 'VALIDATION_FAILED', reason: KillResolveReason, message: string) {
    super(code, message, { detail: message });
    this.reason = reason;
  }
}

/** Non-terminal = every state outside §3.3's terminal set (so paused and awaiting_gate* count). */
export function isKillableRunState(state: RunState): boolean {
  return !TERMINAL_RUN_STATES.includes(state);
}

/** The egress proxy principal of a session, `tc_<testCaseId>.role_<roleId>` (§4.1). */
export function proxyPrincipal(testCaseId: string, roleId: string): string {
  return `tc_${testCaseId}.role_${roleId}`;
}

/** The empty target set: a kill that matched nothing still succeeds and is still recorded. */
export function emptyKillTargetSet(): KillTargetSet {
  return {
    runIds: [],
    sessionIds: [],
    sandboxIds: [],
    virtualKeyIds: [],
    egressIdentities: [],
    workflowIds: [],
  };
}

function requireUuid(refId: string | null, scope: KillScope): string {
  if (refId === null || !uuidV7Schema.safeParse(refId).success) {
    throw new KillResolveError(
      'VALIDATION_FAILED',
      KILL_RESOLVE_REASONS.invalidRef,
      `a ${scope} kill must name a valid ${scope} id`,
    );
  }
  return refId;
}

function checkContext(context: KillResolveContext): void {
  const ok =
    context.kind === 'tenant'
      ? uuidV7Schema.safeParse(context.tenantId).success
      : context.role === PLATFORM_OPERATOR && context.operatorId.trim().length > 0;
  if (!ok) {
    throw new KillResolveError(
      'FORBIDDEN',
      KILL_RESOLVE_REASONS.invalidContext,
      'kill resolution needs a valid tenant or platform-operator context',
    );
  }
}

/** Turns scope and ref into a run query, enforcing the tenant-versus-operator rules. */
function runQueryFor(
  scope: KillScope,
  refId: string | null,
  context: KillResolveContext,
): KillRunQuery {
  switch (scope) {
    case 'run':
      return { by: 'run', runId: requireUuid(refId, scope) };
    case 'asset':
      return { by: 'asset', assetId: requireUuid(refId, scope) };
    case 'tenant':
      if (context.kind === 'operator') {
        return { by: 'tenant', tenantId: requireUuid(refId, scope) };
      }
      if (refId !== null && refId !== context.tenantId) {
        throw new KillResolveError(
          'FORBIDDEN',
          KILL_RESOLVE_REASONS.crossTenant,
          'a tenant kill cannot name another tenant',
        );
      }
      return { by: 'tenant', tenantId: context.tenantId };
    case 'global':
      if (context.kind !== 'operator') {
        throw new KillResolveError(
          'FORBIDDEN',
          KILL_RESOLVE_REASONS.globalRequiresOperator,
          'a global kill needs the platform-operator context, not a tenant context',
        );
      }
      if (refId !== null) {
        throw new KillResolveError(
          'VALIDATION_FAILED',
          KILL_RESOLVE_REASONS.invalidRef,
          'a global kill must not carry a reference',
        );
      }
      return { by: 'all' };
  }
}

function matchesQuery(run: KillRunRow, query: KillRunQuery): boolean {
  switch (query.by) {
    case 'run':
      return run.id === query.runId;
    case 'asset':
      return run.assetIds.includes(query.assetId);
    case 'tenant':
      return run.tenantId === query.tenantId;
    case 'all':
      return true;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

type ProxyPrincipalIdentity = Extract<KillEgressIdentity, { kind: 'proxy_principal' }>;

/**
 * Resolves the targets of a kill.
 *
 * `refId` is the run or asset id for `run`/`asset`, the tenant id for an operator `tenant` kill (a
 * tenant context may pass null or its own id), and null for `global`. Terminal runs are excluded for
 * every scope; a kill that matches nothing returns the empty set. Every list is de-duplicated (sessions
 * by `session_id`) and sorted, so equal inputs always give an equal set.
 *
 * Throws `KillResolveError` (`FORBIDDEN`, reason `kill.resolve.globalRequiresOperator`) when `global`
 * is asked for in a tenant (RLS) context, before any row is read.
 */
export async function resolveKillTargets(
  scope: KillScope,
  refId: string | null,
  tx: KillTargetReader,
): Promise<KillTargetSet> {
  const parsedScope = killScopeSchema.parse(scope);
  const { context } = tx;
  checkContext(context);
  const query = runQueryFor(parsedScope, refId, context);

  // Defence in depth: never rely on the adapter's RLS and filters alone for tenancy or state.
  const inContext = (row: { readonly tenantId: string }): boolean =>
    context.kind === 'operator' || row.tenantId === context.tenantId;

  const runs = (await tx.listRuns(query, TERMINAL_RUN_STATES)).filter(
    (run) => inContext(run) && isKillableRunState(run.state) && matchesQuery(run, query),
  );
  if (runs.length === 0) {
    return emptyKillTargetSet();
  }

  const runIds = sortedUnique(runs.map((run) => run.id));
  const tenantByRun = new Map(runs.map((run) => [run.id, run.tenantId]));
  const belongs = (row: { readonly tenantId: string; readonly runId: string }): boolean =>
    tenantByRun.get(row.runId) === row.tenantId && inContext(row);

  const [sessionRows, subtaskRows] = await Promise.all([
    tx.listSessions(runIds),
    tx.listSubtasks(runIds),
  ]);

  const sessionIds: string[] = [];
  const sandboxIds: string[] = [];
  const virtualKeyIds: string[] = [];
  const workflowIds: string[] = [];
  const principals = new Map<string, ProxyPrincipalIdentity>();

  for (const run of runs) {
    if (run.workflowId !== null) workflowIds.push(run.workflowId);
  }
  for (const session of sessionRows.filter((row) => belongs(row))) {
    sessionIds.push(session.sessionId);
    if (session.sandboxId !== null) sandboxIds.push(session.sandboxId);
    if (session.virtualKeyId !== null) virtualKeyIds.push(session.virtualKeyId);
    if (session.workflowId !== null) workflowIds.push(session.workflowId);
    if (session.testCaseId !== null && session.roleId !== null) {
      const principal = proxyPrincipal(session.testCaseId, session.roleId);
      principals.set(`${session.runId}|${session.sessionId}|${principal}`, {
        kind: 'proxy_principal',
        runId: session.runId,
        sessionId: session.sessionId,
        principal,
      });
    }
  }
  for (const subtask of subtaskRows.filter((row) => belongs(row))) {
    if (subtask.sessionId !== null) sessionIds.push(subtask.sessionId);
    if (subtask.sandboxId !== null) sandboxIds.push(subtask.sandboxId);
  }

  const egressIdentities: KillEgressIdentity[] = [
    ...runIds.map((runId): KillEgressIdentity => ({ kind: 'run', runId })),
    ...[...principals.entries()].sort(([a], [b]) => compare(a, b)).map(([, identity]) => identity),
  ];

  return killTargetSetSchema.parse({
    runIds,
    sessionIds: sortedUnique(sessionIds),
    sandboxIds: sortedUnique(sandboxIds),
    virtualKeyIds: sortedUnique(virtualKeyIds),
    egressIdentities,
    workflowIds: sortedUnique(workflowIds),
  });
}
