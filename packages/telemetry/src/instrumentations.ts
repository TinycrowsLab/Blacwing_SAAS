import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

import type { Instrumentation } from '@opentelemetry/instrumentation';

/**
 * The auto-instrumentation subset every Node app registers (OBS-002, #299): HTTP, NestJS core, `pg` and `ioredis`.
 * Each instrumentation records metadata only (method, route, status, statement shape); none captures request or
 * response bodies or headers. Apps that do not use a library simply never trigger its patch.
 *
 * Fastify has no entry here: `@opentelemetry/instrumentation-fastify` is deprecated upstream in favour of
 * `@fastify/otel`, a per-instance plugin rather than a global patch. The NestJS apps still get server spans from
 * HTTP instrumentation (Fastify serves over Node's `http` server) and controller spans from NestJS core.
 */
export function serviceInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation(),
    new NestInstrumentation(),
    new PgInstrumentation(),
    new IORedisInstrumentation(),
  ];
}
