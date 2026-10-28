import { fileURLToPath } from 'node:url';

import { type DynamicModule, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import { NoSchemaIntrospectionCustomRule } from 'graphql';

import { formatGraphqlErrors, registerGraphqlProblemCodes } from './errors.js';
import {
  createQueryLimitsRule,
  type QueryLimitReason,
  type QueryLimits,
  type QueryShape,
} from './limits.js';
import { createRequestLoaders } from './loaders.js';
import { MembersResolver } from './members.resolver.js';
import { createGraphqlMetrics, type GraphqlMetrics } from './metrics.js';
import { GRAPHQL_MEMBER_STORE, GRAPHQL_METRICS } from './tokens.js';

import type { MemberReadStore } from './store.js';
import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';

/** The schema file `@nestjs/graphql` writes from the decorators (code-first; committed, drift-checked). */
const GRAPHQL_SCHEMA_FILE = fileURLToPath(new URL('../../schema.gql', import.meta.url));

export interface GraphqlModuleOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  /** The app's HTTP metrics; GraphQL counters register on the same registry. */
  readonly metrics: HttpMetrics;
  /** Tenant-scoped read port of the resolvers (Postgres in production). */
  readonly store: MemberReadStore;
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
    const { config, logger, store } = options;
    const metrics: GraphqlMetrics = createGraphqlMetrics(options.metrics.registry);
    const limits = queryLimitsOf(config);
    const production = config.NODE_ENV === 'production';
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
      context: (_request, reply) => ({ reply, loaders: createRequestLoaders(store) }),
    };

    return {
      module: GraphqlApiModule,
      imports: [GraphQLModule.forRoot<MercuriusDriverConfig>(mercurius)],
      providers: [
        { provide: GRAPHQL_MEMBER_STORE, useValue: store },
        { provide: GRAPHQL_METRICS, useValue: metrics },
        MembersResolver,
      ],
    };
  }
}
