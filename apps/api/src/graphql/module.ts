import { fileURLToPath } from 'node:url';

import { type DynamicModule, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import { NoSchemaIntrospectionCustomRule } from 'graphql';

import { AssessmentRequestsResolver } from './assessment-requests.resolver.js';
import { AssetsResolver } from './assets.resolver.js';
import { formatGraphqlErrors, registerGraphqlProblemCodes } from './errors.js';
import { DashboardAssetCountResolver, DashboardResolver } from '../dashboard/dashboard.resolver.js';
import { FindingsResolver } from './findings.resolver.js';
import {
  createQueryLimitsRule,
  type QueryLimitReason,
  type QueryLimits,
  type QueryShape,
} from './limits.js';
import {
  createAssetLoaders,
  createDashboardLoaders,
  createFindingLoaders,
  createRequestLoaders,
  createSurfaceLoaders,
} from './loaders.js';
import { MembersResolver } from './members.resolver.js';
import { createGraphqlMetrics, type GraphqlMetrics } from './metrics.js';
import {
  loadPersistedManifests,
  persistedQueryGate,
  type PersistedManifestFiles,
  type PersistedManifests,
} from './persisted.js';
import { SurfaceResolver } from './surface.resolver.js';
import {
  GRAPHQL_ASSESSMENT_STORE,
  GRAPHQL_ASSETS,
  GRAPHQL_DASHBOARD,
  GRAPHQL_FINDINGS,
  GRAPHQL_MEMBER_STORE,
  GRAPHQL_METRICS,
  GRAPHQL_SURFACE_STORE,
} from './tokens.js';

import type {
  AssessmentReadStore,
  AssetReadStore,
  MemberReadStore,
  SurfaceReadStore,
} from './store.js';
import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { ApiConfig } from '../config.js';
import type { DashboardService } from '../dashboard/service.js';
import type { FindingService } from '../findings/service.js';
import type { Logger } from '@blackwing/logger';

/** The schema file `@nestjs/graphql` writes from the decorators (code-first; committed, drift-checked). */
const GRAPHQL_SCHEMA_FILE = fileURLToPath(new URL('../../schema.gql', import.meta.url));

/** The persisted-query manifests `graphql:persist` writes (API-GQL-PERSIST). */
const PERSISTED_MANIFEST_FILES: PersistedManifestFiles = {
  current: fileURLToPath(new URL('../../graphql/persisted.json', import.meta.url)),
  previous: fileURLToPath(new URL('../../graphql/persisted.previous.json', import.meta.url)),
};

export interface GraphqlModuleOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  /** The app's HTTP metrics; GraphQL counters register on the same registry. */
  readonly metrics: HttpMetrics;
  /** Tenant-scoped read port of the resolvers (Postgres in production). */
  readonly store: MemberReadStore;
  /** Tenant-scoped read port of the assessment-request resolvers (SCOPE-001; Postgres in production). */
  readonly assessments: AssessmentReadStore;
  /** Tenant-scoped read port of the surface resolvers (GRAPH-004; Postgres and the graph in production). */
  readonly surface: SurfaceReadStore;
  /**
   * The finding query service (FINDING query API). Absent: the finding fields answer `GRAPH_QUERY_UNAVAILABLE`
   * (fail closed) and the rest of the schema works.
   */
  readonly findings?: FindingService;
  /**
   * The dashboard read service (DASH-001). Absent: the dashboard fields answer `GRAPH_QUERY_UNAVAILABLE` (fail closed).
   */
  readonly dashboard?: DashboardService;
  /**
   * Tenant-scoped read port of the asset resolvers (ASSET read model; Postgres in production). Absent: the asset
   * fields answer `GRAPH_QUERY_UNAVAILABLE` (fail closed) and the rest of the schema works.
   */
  readonly assets?: AssetReadStore;
  /** The persisted-query manifests; loaded from `apps/api/graphql/` at boot when omitted. */
  readonly persisted?: PersistedManifests;
}

/** The query limits the configuration sets (API-009). */
function queryLimitsOf(config: Readonly<ApiConfig>): QueryLimits {
  return {
    maxDepth: config.API_GQL_MAX_DEPTH,
    maxComplexity: config.API_GQL_MAX_COMPLEXITY,
    maxAliases: config.API_GQL_MAX_ALIASES,
  };
}

/**
 * The GraphQL read layer (API-009): code-first `@nestjs/graphql` on Mercurius, mounted at `/graphql` on the
 * same Fastify server as REST. The global tenant guard and rate limiter apply to it as to REST, and the
 * resolvers run inside the caller's tenant context.
 */
@Module({})
export class GraphqlApiModule {
  static forRoot(options: GraphqlModuleOptions): DynamicModule {
    const { config, logger, store, assessments, surface } = options;
    const findings = options.findings ?? null;
    const dashboard = options.dashboard ?? null;
    const assets = options.assets ?? null;
    const metrics: GraphqlMetrics = createGraphqlMetrics(options.metrics.registry);
    const limits = queryLimitsOf(config);
    const production = config.NODE_ENV === 'production';
    // Production runs only persisted queries unless the configuration says otherwise (API-GQL-PERSIST).
    const persistedOnly = config.API_GQL_PERSISTED_ONLY ?? production;
    const manifests = options.persisted ?? loadPersistedManifests(PERSISTED_MANIFEST_FILES, logger);
    registerGraphqlProblemCodes();

    const mercurius: MercuriusDriverConfig = {
      driver: MercuriusDriver,
      autoSchemaFile: GRAPHQL_SCHEMA_FILE,
      sortSchema: true,
      // Nested fields run interceptors too (spans per resolver; the tenant scope). Guards stay off for fields:
      // the principal is validated and rate limited once per operation, at its root field.
      fieldResolverEnhancers: ['interceptors'],
      // Mercurius' function form of validationRules (the variables reach the limits) needs the document cache off.
      cache: false,
      graphiql: !production,
      // The persisted-query gate runs before Mercurius reads the document, on GET and POST alike.
      additionalRouteOptions: {
        preHandler: persistedQueryGate({ manifests, persistedOnly, metrics, logger }),
      },
      validationRules: ({ variables }) => [
        createQueryLimitsRule(limits, variables ?? {}, {
          onOperation: (operation, shape) => {
            metrics.requests.inc({ operation });
            metrics.complexity.observe(shape.complexity);
          },
          onRejected: (reason: QueryLimitReason, operation: string, shape: QueryShape) => {
            metrics.rejected.inc({ reason });
            logger.warn(
              {
                operation,
                reason,
                depth: shape.depth,
                complexity: shape.complexity,
                aliases: shape.aliases,
              },
              'graphql.query_rejected',
            );
          },
        }),
        // Introspection is a development aid; in production the schema is not enumerable.
        ...(production ? [NoSchemaIntrospectionCustomRule] : []),
      ],
      errorFormatter: (execution) => formatGraphqlErrors(execution),
      context: (_request, reply) => ({
        reply,
        loaders: {
          ...createRequestLoaders(store),
          ...createSurfaceLoaders(surface, (size) => {
            metrics.dataloaderBatchSize.observe(size);
          }),
          ...createFindingLoaders(findings),
          ...createAssetLoaders(assets),
          ...createDashboardLoaders(dashboard),
        },
      }),
    };

    return {
      module: GraphqlApiModule,
      imports: [GraphQLModule.forRoot<MercuriusDriverConfig>(mercurius)],
      providers: [
        { provide: GRAPHQL_MEMBER_STORE, useValue: store },
        { provide: GRAPHQL_ASSESSMENT_STORE, useValue: assessments },
        { provide: GRAPHQL_SURFACE_STORE, useValue: surface },
        { provide: GRAPHQL_FINDINGS, useValue: findings },
        { provide: GRAPHQL_DASHBOARD, useValue: dashboard },
        { provide: GRAPHQL_ASSETS, useValue: assets },
        { provide: GRAPHQL_METRICS, useValue: metrics },
        MembersResolver,
        AssessmentRequestsResolver,
        SurfaceResolver,
        FindingsResolver,
        AssetsResolver,
        DashboardResolver,
        DashboardAssetCountResolver,
      ],
    };
  }
}
