import type { Logger } from '@blackwing/logger';
import type { LoggerService } from '@nestjs/common';

/** Splits Nest's `(message, ...optionalParams)` into the message and its trailing context name. */
function split(params: readonly unknown[]): {
  readonly context?: string;
  readonly rest: unknown[];
} {
  const last = params.at(-1);
  if (typeof last === 'string') return { context: last, rest: params.slice(0, -1) };
  return { rest: [...params] };
}

function fields(context: string | undefined, extra: Record<string, unknown> = {}): object {
  return context === undefined ? extra : { nestContext: context, ...extra };
}

function text(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * Routes Nest's own logging (module init, route mapping, lifecycle errors) through the pino logger of
 * `@blackwing/logger`, so framework lines are the same single-line, redacted JSON as everything else.
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(fields(split(params).context), text(message));
  }

  error(message: unknown, ...params: unknown[]): void {
    const { context, rest } = split(params);
    const stack = rest.find((value): value is string => typeof value === 'string');
    const err = message instanceof Error ? message : undefined;
    this.logger.error(
      fields(context, {
        ...(err === undefined ? {} : { err }),
        ...(stack === undefined ? {} : { stack }),
      }),
      text(message),
    );
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(fields(split(params).context), text(message));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(fields(split(params).context), text(message));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.trace(fields(split(params).context), text(message));
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.logger.fatal(fields(split(params).context), text(message));
  }
}
