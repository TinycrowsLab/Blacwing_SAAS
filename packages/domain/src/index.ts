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
