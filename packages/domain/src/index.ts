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

export {
  assertSeverityMatchesVectors,
  FINDING_CVSS_SPAN,
  FINDING_SEVERITY_METRIC,
} from './findings/cvss.js';

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

export { type DiffablePlan, diffPlans } from './test-plans/diff.js';

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
  nodeScopeDecision,
  parseSurfaceWriteRequest,
  requireSurfaceTenant,
  SURFACE_MAX_EDGES,
  SURFACE_MAX_NODES,
  SURFACE_SOURCE_KINDS,
  SURFACE_WRITE_METRIC,
  SURFACE_WRITE_METRIC_LABELS,
  type SurfaceAuditEvent,
  type SurfaceEdge,
  surfaceEdgeSchema,
  type SurfaceNode,
  surfaceNodeKey,
  surfaceNodeSchema,
  type SurfaceProvenance,
  type SurfaceSourceKind,
  type SurfaceWriteContext,
  type SurfaceWriteRequest,
  surfaceWriteRequestSchema,
  type SurfaceWriteResult,
  writeSurface,
  WRITE_SURFACE_TOOL,
} from './surface/write.js';
export {
  GATE_DECISION_AUDIT_ACTION,
  GATE_DECISION_METRIC,
  GATE_DECISION_METRIC_LABELS,
  type GateDecisionAuditEvent,
  type GateDecisionPorts,
  type GateDecisionRow,
  recordGateDecision,
} from './gate/record.js';
export {
  applySurfaceWrite,
  emptySurfaceModel,
  getMergedSurface,
  mergeSurfaceWrite,
  type MergedSurfaceEdge,
  type MergedSurfaceNode,
  type MergedSurfaceOptions,
  type MergedSurfacePage,
  readMergedSurface,
  SURFACE_CONFLICTS_METRIC,
  SURFACE_MERGE_SPAN,
  SURFACE_NODES_METRIC,
  SURFACE_PAGE_DEFAULT,
  SURFACE_PAGE_MAX,
  type SurfaceConflictField,
  type SurfaceEntity,
  type SurfaceMergeContext,
  type SurfaceMergeStats,
  type SurfaceModel,
  type SurfaceModelStore,
  type SurfaceObservation,
  type TechnologyAlternative,
} from './surface/merge.js';

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

export { type Classification, classifyFinding } from './findings/classify.js';
export {
  DEFAULT_MAPPING_DATASET,
  loadMappingDataset,
  type MappingDataset,
  type MappingEntry,
} from './findings/mappings.js';
export {
  candidateRefsSchema,
  type CandidateRefs,
  cweRefSchema,
  owaspTop10RefSchema,
  parseTaxon,
} from './findings/taxonomy.js';
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
