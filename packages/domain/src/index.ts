/** Workspace package name of this package. */
export const name = '@blackwing/domain';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  assertSaDraft,
  InvalidSaWindowError,
  type SaDraftFields,
} from './authorisation/validate.js';
export {
  IllegalSaTransitionError,
  SA_EVENT_TYPES,
  SA_TRANSITIONS,
  type SaActor,
  type SaAuditIntent,
  type SaEventType,
  type SaState,
  type SaTransitionContext,
  type SaTransitionResult,
  transitionSa,
} from './authorisation/state.js';

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

export { InvalidSurfaceInputError, SurfaceBatchTooLargeError } from './surface/errors.js';
export {
  endpointKey,
  hostKey,
  parameterKey,
  roleKey,
  serviceKey,
  technologyKey,
} from './surface/fingerprint.js';
export { normaliseUrlTemplate, parseSurfaceUrl, type SurfaceUrl } from './surface/normalise.js';
export {
  addressRules,
  SURFACE_MAX_EDGES,
  SURFACE_MAX_NODES,
  SURFACE_WRITE_METRIC,
  SURFACE_WRITE_METRIC_LABELS,
  type SurfaceAuditEvent,
  type SurfaceEdge,
  surfaceEdgeSchema,
  type SurfaceNode,
  surfaceNodeKey,
  surfaceNodeSchema,
  type SurfaceProvenance,
  type SurfaceWriteContext,
  type SurfaceWriteRequest,
  surfaceWriteRequestSchema,
  type SurfaceWriteResult,
  writeSurface,
  WRITE_SURFACE_TOOL,
} from './surface/write.js';

export {
  type Catalogue,
  CatalogueError,
  type CatalogueEntry,
  defineCatalogue,
  entryCountsByClass,
  NEGATIVE_CONTROL_STRATEGIES,
  type NegativeControlStrategy,
  ORACLE_TYPES,
  type OracleType,
  selectApplicable,
} from './testcases/catalogue.js';
export {
  isKnownApiTop10,
  isKnownCwe,
  isKnownOwaspTop10,
  isKnownWstg,
} from './testcases/standards.js';
export {
  WEBAPI_CATALOGUE,
  WEBAPI_CATALOGUE_METRIC,
  WEBAPI_CATALOGUE_METRIC_LABELS,
  webApiCatalogueMetricSamples,
} from './testcases/webapi.js';

export {
  RECON_BUDGET_SHARE,
  RECON_INTRUSIVENESS_CEILING,
  RECON_PERSONAS,
  type ReconIntrusiveness,
  type ReconManifest,
  type ReconManifestEntry,
  type ReconManifestWarning,
  type ReconPersona,
  type ResolveReconManifestOptions,
  resolveReconManifest,
} from './recon/manifest.js';
