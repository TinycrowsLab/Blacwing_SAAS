/**
 * The registry of public-id prefixes and the branded type each one produces.
 *
 * Adding an entity: add `prefix: "EntityId"` here, add the matching type alias and constructor in
 * `entities.ts`, and extend the registry test. Prefixes are lowercase `a-z` only, and a prefix is
 * never reused or renamed once ids carrying it have been issued: public ids appear in audit events
 * (CONTEXT_PACK §8.8), tickets, reports and customer systems.
 */
export const ID_PREFIXES = Object.freeze({
  /** Runs (`runs`, §7). */
  run: 'RunId',
  /** Findings (`findings`). */
  fnd: 'FindingId',
  /** Assets (`assets`). */
  asset: 'AssetId',
  /** Standing authorisations (`standing_authorisations`). */
  sa: 'StandingAuthorisationId',
  /** Test plans (`test_plans`). */
  tp: 'TestPlanId',
  /** Test cases (`test_cases`). */
  tc: 'TestCaseId',
  /** Subtasks (`subtasks`). */
  sub: 'SubtaskId',
  /** Agent sessions (`agent_sessions`). */
  sess: 'SessionId',
  /** Evidence items (`evidence_items`). */
  evd: 'EvidenceId',
  /** API token records (`api_tokens`). The row id, never the `bw_pat_`/`bw_ci_` secret itself. */
  tok: 'ApiTokenId',
  /** Tenants (`tenants`). */
  ten: 'TenantId',
  /** Users (`users`). */
  usr: 'UserId',
  /** OOB correlations (`oob_correlations`). */
  oob: 'OobId',
  /** Kill events (`kill_events`). */
  kill: 'KillEventId',
  /** Assessment requests (`assessment_requests`, SCOPE-001). */
  areq: 'AssessmentRequestId',
} as const);

/** A registered public-id prefix. */
export type IdPrefix = keyof typeof ID_PREFIXES;

/** The brand name for a prefix, e.g. `BrandOf<"run">` is `"RunId"`. */
export type BrandOf<P extends IdPrefix> = (typeof ID_PREFIXES)[P];

/** Every registered prefix, in registry order. */
export const ID_PREFIX_LIST: readonly IdPrefix[] = Object.freeze(
  Object.keys(ID_PREFIXES) as IdPrefix[],
);

/** True when `value` is a registered prefix. */
export function isIdPrefix(value: unknown): value is IdPrefix {
  return typeof value === 'string' && Object.hasOwn(ID_PREFIXES, value);
}
