import {
  createParamDecorator,
  type ArgumentMetadata,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';

import { exceedsJsonDepth } from './json-depth.js';
import {
  MAX_REPORTED_ISSUES,
  RequestValidationError,
  type ValidationIssueDetail,
  type ValidationSource,
} from './request-validation.error.js';
import { isZodDto, type ZodDto } from './zod-dto.js';
import { currentRoute } from '../bootstrap/request-context.js';

import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyRequest } from 'fastify';

/** `data` of the `@ZodBody/@ZodQuery/@ZodParam/@ZodHeaders` decorators: which DTO, from which part. */
interface ZodParamSpec {
  readonly zodSource: ValidationSource;
  readonly dto: ZodDto;
}

function isZodParamSpec(value: unknown): value is ZodParamSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    isZodDto((value as { dto?: unknown }).dto) &&
    typeof (value as { zodSource?: unknown }).zodSource === 'string'
  );
}

const extractRequestPart = createParamDecorator((spec: ZodParamSpec, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  switch (spec.zodSource) {
    case 'body':
      return request.body;
    case 'query':
      return request.query;
    case 'params':
      return request.params;
    case 'headers':
      return request.headers;
  }
});

function makeDecorator(source: ValidationSource): (dto: ZodDto) => ParameterDecorator {
  return (dto) => extractRequestPart({ zodSource: source, dto } satisfies ZodParamSpec);
}

/** The validated request body as `dto`. Unknown keys are rejected (`422`). */
export const ZodBody = makeDecorator('body');
/** The validated query string as `dto`. Declare numbers with `z.coerce.number()`; unknown keys are dropped. */
export const ZodQuery = makeDecorator('query');
/** The validated path parameters as `dto`. */
export const ZodParam = makeDecorator('params');
/** The validated request headers as `dto` (header names are lower-case). */
export const ZodHeaders = makeDecorator('headers');

/** Dotted path with bracketed indexes: `['a', 0, 'b']` becomes `a[0].b`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** Zod issues as `{path, message, code}`; the submitted values are never copied into the result. */
export function toIssueDetails(issues: readonly z.core.$ZodIssue[]): ValidationIssueDetail[] {
  return issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Bodies reject unknown keys (mass-assignment / over-posting defence, CWE-915). A schema that already
 * chose a policy (`z.strictObject`, `z.looseObject`, catchall) is left alone.
 */
function strictBodySchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject && schema._zod.def.catchall === undefined) {
    return schema.strict();
  }
  return schema;
}

export interface ZodValidationPipeOptions {
  readonly maxJsonDepth: number;
  readonly metrics?: HttpMetrics;
  readonly logger?: Logger;
  /** Route label for the failure metric; defaults to the matched route of the current request. */
  readonly route?: () => string | undefined;
}

/**
 * Global validation pipe (`APP_PIPE`). It validates exactly the handler parameters bound to a Zod DTO:
 * those declared with `@ZodBody/@ZodQuery/@ZodParam/@ZodHeaders`, or a `@Body()/@Query()/@Param()` whose
 * emitted type is a `createZodDto` class. Everything else (raw-body and webhook routes, `@Req()`, plain
 * `unknown` parameters) passes through untouched, so signature-verified raw bodies are never altered.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly options: ZodValidationPipeOptions) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const target = this.resolve(metadata);
    if (target === undefined) return value;
    const { dto, source } = target;

    if (source === 'body' && exceedsJsonDepth(value, this.options.maxJsonDepth)) {
      this.reject(source, [
        {
          path: '',
          message: `JSON nesting is deeper than the allowed ${String(this.options.maxJsonDepth)} levels`,
          code: 'json_depth_exceeded',
        },
      ]);
    }

    const schema = source === 'body' ? strictBodySchema(dto.schema) : dto.schema;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    return this.reject(source, toIssueDetails(result.error.issues), result.error);
  }

  private resolve(
    metadata: ArgumentMetadata,
  ): { readonly dto: ZodDto; readonly source: ValidationSource } | undefined {
    if (metadata.type === 'custom') {
      return isZodParamSpec(metadata.data)
        ? { dto: metadata.data.dto, source: metadata.data.zodSource }
        : undefined;
    }
    if (!isZodDto(metadata.metatype)) return undefined;
    switch (metadata.type) {
      case 'body':
        return { dto: metadata.metatype, source: 'body' };
      case 'query':
        return { dto: metadata.metatype, source: 'query' };
      case 'param':
        return { dto: metadata.metatype, source: 'params' };
    }
  }

  private reject(
    source: ValidationSource,
    errors: readonly ValidationIssueDetail[],
    cause?: unknown,
  ): never {
    const route = (this.options.route ?? currentRoute)() ?? 'unmatched';
    this.options.metrics?.validationFailures.inc({ route });
    // Paths and rule codes only; submitted values never reach the log.
    this.options.logger?.debug(
      { route, source, fields: errors.map((e) => ({ path: e.path, code: e.code })) },
      'http.validation_failed',
    );
    throw new RequestValidationError(source, errors, cause);
  }
}

/** `APP_PIPE` factory. */
export function createValidationPipe(
  config: Readonly<ApiConfig>,
  metrics: HttpMetrics,
  logger: Logger,
): ZodValidationPipe {
  return new ZodValidationPipe({ maxJsonDepth: config.API_MAX_JSON_DEPTH, metrics, logger });
}
