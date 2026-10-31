/** Workspace package name of this package. */
export const name = '@blackwing/db';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// Runtime entry point: the app-role pool only. The owner pool is `@blackwing/db/owner` (DB-001).
export {
  appDatabase,
  type AppDatabase,
  closeDb,
  createAppDatabase,
  type CreateAppDatabaseOptions,
  createDatabase,
  type Database,
  DEFAULT_PING_TIMEOUT_MS,
  type DbHealth,
  getDb,
  pingDb,
  pingPool,
  type Tx,
  UnsafeDbRoleError,
  verifyAppRole,
} from './client.js';
export {
  appDbEnvSchema,
  DB_ROLES,
  dbTxEnvSchema,
  DEFAULT_DB_TX_ISOLATION,
  DEFAULT_DB_TX_MAX_RETRIES,
  type DbTxConfig,
  loadDbTxConfig,
  MAX_DB_TX_MAX_RETRIES,
  TX_ISOLATION_LEVELS,
  type TxIsolation,
  type DbConnectionConfig,
  DEFAULT_PG_ACQUIRE_TIMEOUT_MS,
  DEFAULT_PG_DATABASE,
  DEFAULT_DB_IDLE_TX_TIMEOUT_MS,
  DEFAULT_DB_LOCK_TIMEOUT_MS,
  DEFAULT_DB_SLOW_QUERY_MS,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  type AppDbConnectionConfig,
  type QueryGuardConfig,
  DEFAULT_PG_IDLE_TIMEOUT_MS,
  DEFAULT_PG_POOL_MAX,
  DEFAULT_PG_PORT,
  loadAppDbConfig,
  PG_SSL_MODES,
  type PgSslMode,
} from './env.js';
export {
  assertMigrationAllowed,
  type DestructiveKind,
  DestructiveMigrationError,
  type DestructiveStatement,
  findDestructiveStatements,
  type GuardedMigration,
  type MigrationGuardEnv,
} from './migrate-guard.js';
export {
  DOWN_MIGRATIONS_DIR,
  loadMigrations,
  type MigrateOptions,
  migrateDatabase,
  type MigrationEntry,
  type MigrationLogger,
  migrationNames,
  type MigrationResult,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  rollbackLatestMigration,
} from './migrate.js';
export {
  type DbLogger,
  type DbPoolMetrics,
  DbUnavailableError,
  type DbUnavailableReason,
  ObservedPool,
  type PoolName,
} from './pool.js';
export {
  CheckViolationError,
  mapDbError,
  QueryTimeoutError,
  SerializationConflictError,
  MemoryEmbedDimMismatchError,
  UniqueViolationError,
  unwrapQueryError,
} from './query-errors.js';
export {
  type DbTxMetrics,
  RETRYABLE_PG_CODES,
  type SystemAccessEvent,
  type SystemAuditEmitter,
  type SystemTx,
  TenantContextMismatchError,
  type TenantTx,
  type TxLogger,
  type TxOptions,
  TxRetryExhaustedError,
  withSystem,
  withTenant,
  type WithSystemOptions,
} from './with-tenant.js';
export {
  assertTenantScope,
  type AssertTenantScopeOptions,
  type TenantScopedDb,
} from './tenant-scope.js';
export {
  createCrossTenantGuard,
  type CrossTenantAuditEmitter,
  type CrossTenantDeniedEvent,
  type CrossTenantGuard,
  type CrossTenantGuardOptions,
  type CrossTenantLogger,
  currentTenantId,
  getTenantContext,
  getTenantContextOrThrow,
  hashTenantId,
  perTenantContext,
  resolveTenantContext,
  runWithTenantContext,
  type TenantActor,
  type TenantActorType,
  type TenantContext,
  type TenantContextMetrics,
  type TenantPrincipal,
} from './tenant-context.js';
export {
  type AppendEvidenceInput,
  type EvidenceItemRow,
  EvidenceRepository,
  type EvidenceRepositoryOptions,
  type FindingForBinding,
  type OccurrenceForBinding,
  type ReproArtifactRow,
  ReproArtifactRepository,
} from './evidence.repository.js';
export * from './schema/index.js';
export * from './columns.js';
export * from './vector.js';
export {
  APP_ROLE,
  assertRlsEnabled,
  readRlsState,
  RLS_PREDICATE,
  rlsMigrationSql,
  rlsPolicyName,
  rlsPolicySql,
  RlsConfigError,
  SELF_KEYED_TABLES,
  type RlsPolicyOptions,
  type RlsQueryable,
  type RlsState,
  STATEMENT_BREAKPOINT,
  TENANT_COLUMN,
  toTenantIsolationError,
} from './rls.js';
export {
  type AuditEmitter,
  BaseRepository,
  ConcurrencyError,
  CursorInvalidError,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  ForeignKeyError,
  type CursorPosition,
  type ListOptions,
  MAX_PAGE_LIMIT,
  type RepositoryAuditEvent,
  type RepositoryConfig,
  type RepositoryOp,
  type RepositoryPage,
  type RepositoryTable,
  type RepositoryTracer,
  type RowOf,
  type TenantContextSource,
} from './repository.js';
export {
  AssetCredentialRepository,
  type NewAssetCredentialWrite,
  type NewCredentialSecret,
} from './asset-credential.repository.js';
export {
  AssetRepository,
  type AssetListPage,
  type AssetListRow,
  type AssetRepositoryOptions,
} from './asset.repository.js';
export {
  AssessmentRequestRepository,
  type AssessmentRequestAuditEvent,
  type AssessmentRequestAuditHook,
  type AssessmentRequestCreate,
  type AssessmentRequestMetrics,
  type AssessmentRequestRepositoryOptions,
  type AssessmentRequestRow,
  type AssessmentRequestUpdate,
} from './assessment-request.repository.js';
export {
  type TestCaseRow,
  type TestPlanCreate,
  TestPlanRepository,
  type TestCasePatch,
  type TestCaseRemoval,
  type TestCaseWithPlan,
  type TestCaseWriteInput,
  type TestPlanAuditEvent,
  type TestPlanAuditHook,
  type TestPlanRepositoryOptions,
  type TestPlanRow,
  type TestPlanWithCases,
} from './test-plans.repository.js';
export { CoverageRepository, type CoverageManifestWithEntries } from './coverage.repository.js';
export {
  type ChannelUpdateWrite,
  type NewChannelWrite,
  type NotificationChannelAuditEvent,
  type NotificationChannelAuditHook,
  type NotificationChannelOp,
  NotificationChannelRepository,
  type NotificationChannelRepositoryOptions,
  type SealedChannelSecret,
  NOTIFICATION_CHANNEL_LIST_LIMIT,
} from './notification-channel.repository.js';
export { type NotificationChannelRow } from './schema/notifications.js';
export {
  type TenantSettingsAuditEvent,
  type TenantSettingsAuditHook,
  type TenantSettingsChange,
  TenantSettingsRepository,
  type TenantSettingsRepositoryOptions,
  type TenantSettingsRecord,
  type TenantSettingsWrite,
} from './tenant-settings.repository.js';
export {
  type OrgSettingsAuditEvent,
  type OrgSettingsAuditHook,
  type TenantProfileRecord,
  TenantProfileRepository,
  type TenantProfileRepositoryOptions,
  type TenantProfileWrite,
} from './tenant-profile.repository.js';
export {
  createPgPersonaOverrideStore,
  type PersonaOverrideColumns,
  type PgPersonaOverrideStore,
  type StoredPersonaOverride,
} from './persona-overrides.js';
export {
  createPgVirtualKeyStore,
  createVirtualKeyAuthenticator,
  type NewVirtualKey,
  type StoredVirtualKey,
  type VirtualKeyStore,
} from './virtual-keys.repository.js';
export {
  AuthzGateDecisionRepository,
  type AuthzGateDecisionRepositoryOptions,
} from './authz-gate-decision.repository.js';
export {
  createPgGate2DecisionStore,
  type Decide,
  type GateDecisionKind,
  type GateDecisionStatus,
  type OpenGate2Input,
  type PgGate2DecisionStore,
  type StoredGate2Decision,
} from './gate-decisions.js';
export { positionalSql, txQuery, type TxQueryResult } from './tx-query.js';
export {
  OutboxDuplicateError,
  type OutboxMetrics,
  withOutbox,
  type WithOutboxOptions,
} from './outbox.js';
export {
  type ClaimedOutboxRow,
  outboxBacklog,
  type OutboxClaim,
  withOutboxClaim,
} from './outbox-relay.js';

export { type AuditSqlTxLike, toAuditSqlTx } from './audit-sql-tx.js';
export {
  type GateDecisionAuditHook,
  type NewStandingAuthorisation,
  type StandingAuthorisationApproval,
  type StandingAuthorisationAuditAction,
  type StandingAuthorisationAuditEvent,
  type StandingAuthorisationAuditHook,
  type StandingAuthorisationDecision,
  type StandingAuthorisationFields,
  type StandingAuthorisationRecord,
  StandingAuthorisationRepository,
  type StandingAuthorisationRepositoryOptions,
  type StandingAuthorisationWrite,
} from './standing-authorisation.repository.js';
export { unverifiedAssetIds } from './asset-verification.repository.js';
export { type InputManifestRow, InputManifestRepository } from './input-manifest.repository.js';

export {
  AssetCatalogRepository,
  type AssetCatalogEntry,
  type AssetCatalogRepositoryOptions,
} from './asset-catalog.repository.js';
export {
  StandingAuthorisationReader,
  type StandingAuthorisationEntry,
  type StandingAuthorisationReaderOptions,
} from './standing-authorisation-reader.repository.js';
export {
  PlanValidationRepository,
  type PlanAuthorisation,
  type PlanRunBudgets,
  type PlanValidatedAuditEvent,
  type PlanValidationAuditHook,
  type PlanValidationRepositoryOptions,
  type PlanValidationSnapshot,
} from './plan-validation.repository.js';
export {
  type QuotaCountResource,
  QuotaUsageRepository,
  type QuotaUsageCounts,
} from './quota.repository.js';
export {
  TenantHaltRepository,
  type TenantHaltRepositoryOptions,
} from './tenant-halt.repository.js';
export {
  type AcceptedRiskCursor,
  type ReleasedCursor,
  type ReportFindingRow,
  type ReportRunRow,
  type ReportSource,
  withReportSource,
} from './report-source.repository.js';
export {
  type AssetCoverageRow,
  type CountRow,
  DashboardRepository,
  type DashboardPosition,
  type FindingSummaryRows,
  type HiddenStatuses,
  type TrendRow,
} from './dashboard.repository.js';
export {
  FindingRepository,
  type FindingOccurrenceRow,
  type FindingPage,
  type FindingQuery,
  type FindingRepositoryOptions,
  type FindingRow,
} from './finding.repository.js';
export {
  type FindingTriageAuditHook,
  FindingTriageRepository,
  type FindingTriageRepositoryOptions,
  type FindingTriageRequest,
  type FindingTriageResult,
} from './finding-triage.repository.js';
export {
  createGate2Service,
  gate2DatabaseNow,
  type Gate2AuditEvent,
  type Gate2AuditSink,
  type Gate2CreateResult,
  type Gate2DecideResult,
  type Gate2DecisionRequest,
  type Gate2Metrics,
  gate2Service,
  type Gate2Service,
  type Gate2ServiceOptions,
  pendingGate2ExceptionIds,
  toGate2Exception,
} from './gate2.js';
export { drizzleGate2Store, type Gate2Store, type Gate2Transition } from './gate2-store.js';
export {
  reversalJournalRepository,
  type ReversalJournalListOptions,
  type UndoStatusMeta,
} from './reversal-journal.repository.js';
export {
  type ActivationResult,
  type NewPolicyVersion,
  PolicyVersionNotFoundError,
  type PolicyVersion,
  type PolicyVersionSummary,
  type TenantPolicyAuditEvent,
  type TenantPolicyAuditHook,
  TenantPolicyRepository,
  type TenantPolicyRepositoryOptions,
} from './tenant-policy.repository.js';
export {
  PolicyDecisionLogRepository,
  type PolicyDecisionLogEntry,
  type PolicyDecisionLogRecord,
  type PolicyDecisionLogRepositoryOptions,
} from './policy-decision-log.repository.js';
export {
  roleSessionRepository,
  type RoleSessionWrite,
  type TerminalStoredSessionStatus,
} from './role-sessions.repository.js';
