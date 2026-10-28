import { GqlExecutionContext } from '@nestjs/graphql';

import type { ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * What a GraphQL resolver's context carries besides the Fastify request (API-009). The request is
 * assigned by the Mercurius driver; `reply` is supplied by the GraphQL context factory.
 */
interface GraphqlTransportContext {
  readonly req?: FastifyRequest;
  readonly reply?: FastifyReply;
}

/**
 * The Fastify request behind an HTTP route or a GraphQL operation (API-009). Both transports pass
 * through the same tenant guard and rate limiter, so a GraphQL query is subject to the same authn,
 * tenant resolution and limits as REST. `undefined` for any other transport (refused by callers).
 */
export function requestOf(context: ExecutionContext): FastifyRequest | undefined {
  if (context.getType() === 'http') return context.switchToHttp().getRequest<FastifyRequest>();
  if (context.getType<string>() === 'graphql')
    return GqlExecutionContext.create(context).getContext<GraphqlTransportContext>().req;
  return undefined;
}

/** The Fastify reply behind an HTTP route or a GraphQL operation, when the transport has one. */
export function replyOf(context: ExecutionContext): FastifyReply | undefined {
  if (context.getType() === 'http') return context.switchToHttp().getResponse<FastifyReply>();
  if (context.getType<string>() === 'graphql')
    return GqlExecutionContext.create(context).getContext<GraphqlTransportContext>().reply;
  return undefined;
}

/**
 * True when the call is the transport's entry point: every HTTP handler, and the root field of a GraphQL
 * operation. Nested field resolvers of one operation are not separate requests, so per-request guards
 * (rate limiting) charge only the entry point.
 */
export function isEntryPoint(context: ExecutionContext): boolean {
  if (context.getType() === 'http') return true;
  if (context.getType<string>() !== 'graphql') return false;
  return (
    GqlExecutionContext.create(context).getInfo<{ path: { prev?: unknown } }>().path.prev ===
    undefined
  );
}
