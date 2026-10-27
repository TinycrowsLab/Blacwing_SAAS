/** Workspace package name of this package. */
export const name = '@blackwing/domain';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  hasPermission,
  knownRoles,
  permissionsForRoles,
  type RbacOptions,
  type RbacWarnSink,
  UNKNOWN_ROLE_WARNING,
} from './rbac/permissions.js';

export {
  emptyKillTargetSet,
  isKillableRunState,
  KILL_RESOLVE_REASONS,
  KILL_RESOLVE_SPAN,
  type KillResolveContext,
  KillResolveError,
  type KillResolveReason,
  type KillRunQuery,
  type KillRunRow,
  type KillSessionRow,
  type KillSubtaskRow,
  type KillTargetReader,
  proxyPrincipal,
  resolveKillTargets,
} from './kill/resolve.js';

export { matchScope, ruleSpecificity } from './scope/matcher.js';

export {
  applyTransition,
  canAcceptTargetTraffic,
  describeTransition,
  IllegalRunEventError,
  isTerminal,
  nextVersion,
  type PausableState,
  type PausedReason,
  requiresEnvelope,
  RUN_EVENT_TYPES,
  RUN_STATES,
  RUN_TRANSITIONS_METRIC,
  RUN_TRANSITIONS_METRIC_LABELS,
  type RunActor,
  type RunAuditIntent,
  type RunEvent,
  type RunEventType,
  type RunState,
  type RunStatus,
  type RunTransitionContext,
  type SimpleRunEventType,
  transitions,
  type TransitionResult,
} from './run/state.js';

export {
  Gate2AlreadyDecidedError,
  Gate2DestructiveForbiddenError,
  Gate2SeparationOfDutiesError,
  IllegalGate2TransitionError,
} from './gate2/errors.js';
export {
  applyGate2Event,
  describeGate2Transition,
  GATE2_EVENT_TYPES,
  GATE2_EXCEPTIONS_METRIC,
  GATE2_EXCEPTIONS_METRIC_LABELS,
  GATE2_TRANSITION_LOG,
  GATE2_TRANSITIONS,
  type Gate2Actor,
  type Gate2AuditIntent,
  type Gate2DecisionRecord,
  type Gate2Event,
  type Gate2EventType,
  type Gate2State,
  type Gate2Status,
  type Gate2TransitionContext,
  type Gate2TransitionResult,
  gate2Allows,
  isGate2Terminal,
  nextGate2Version,
} from './gate2/state.js';
