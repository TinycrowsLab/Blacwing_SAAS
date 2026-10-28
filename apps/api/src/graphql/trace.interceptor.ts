import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { finalize, type Observable, tap } from 'rxjs';

import { API_LOGGER } from '../bootstrap/tokens.js';

import type { Logger } from '@blackwing/logger';
import type { GraphQLResolveInfo } from 'graphql';

/** Tracer of the GraphQL resolver spans. */
const GRAPHQL_TRACER_NAME = '@blackwing/api.graphql';

/** A root field slower than this is logged as `graphql.slow_operation` (no query text, no variables). */
const SLOW_OPERATION_MS = 1000;

/**
 * Wraps every GraphQL resolver in a span named `graphql <Type>.<field>` (API-009) and logs slow root
 * fields. Other transports pass through untouched.
 */
@Injectable()
export class GraphqlTraceInterceptor implements NestInterceptor {
  constructor(@Inject(API_LOGGER) private readonly logger: Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'graphql') return next.handle();
    const info = GqlExecutionContext.create(context).getInfo<GraphQLResolveInfo>();
    const span = trace
      .getTracer(GRAPHQL_TRACER_NAME)
      .startSpan(`graphql ${info.parentType.name}.${info.fieldName}`);
    const started = performance.now();
    return next.handle().pipe(
      tap({
        error: () => {
          span.setStatus({ code: SpanStatusCode.ERROR });
        },
      }),
      finalize(() => {
        const durationMs = Math.round(performance.now() - started);
        if (info.path.prev === undefined && durationMs >= SLOW_OPERATION_MS)
          this.logger.warn({ operation: info.fieldName, durationMs }, 'graphql.slow_operation');
        span.end();
      }),
    );
  }
}
