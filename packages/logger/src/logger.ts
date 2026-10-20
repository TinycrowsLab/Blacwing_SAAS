import { pino } from 'pino';

import {
  drainConfigLoadEvents,
  LOG_LEVELS,
  type LogLevel,
  NODE_ENVS,
  type NodeEnv,
} from '@blackwing/config';
import { ValidationError } from '@blackwing/errors';

import { REDACT_PATHS, REDACTED, redactSerializedLine } from './redaction.js';
import {
  DEFAULT_LIMITS,
  sanitize,
  sanitizeRecord,
  sanitizeString,
  type SanitizeLimits,
} from './sanitize.js';
import { activeTraceFields, type TraceFields } from './trace.js';

/** A Blackwing logger: a pino logger whose every line is sanitised, redacted and trace-correlated. */
export type Logger = pino.Logger;

declare const tenantScoped: unique symbol;

/**
 * A logger bound to a tenant by {@link withContext}. Data-path code (anything that reads or writes
 * tenant data, CONTEXT_PACK §7/§8.6) takes a `TenantLogger` instead of a `Logger`, so the compiler
 * enforces the "data-path logs carry `tenantId`" convention without a runtime check.
 */
export type TenantLogger = Logger & { readonly [tenantScoped]: true };

/** Correlation context bound to a child logger. Every field is optional; empty strings are ignored. */
export interface LogContext {
  readonly tenantId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  /**
   * Trace id to use when no OpenTelemetry span is active (for example a job that carries the trace id
   * of the request that queued it). An active span always wins.
   */
  readonly traceId?: string;
}

/** {@link LogContext} with the tenant set: what data-path code must bind. */
export interface TenantLogContext extends LogContext {
  readonly tenantId: string;
}

/** Process-wide logger settings, normally taken from the app's `@blackwing/config` result. */
export interface LoggerSettings {
  /** Minimum level emitted. Pass `config.LOG_LEVEL`. Default `info`. */
  readonly level?: LogLevel;
  /** Pass `config.NODE_ENV`. Only `development` gets the pino-pretty transport; anything else is JSON on stdout. */
  readonly nodeEnv?: NodeEnv;
  /** Longest logged string in UTF-8 bytes before it is cut with `[truncated]`. Default 8192. */
  readonly maxFieldBytes?: number;
  /** Deepest object nesting kept. Default 10. */
  readonly maxDepth?: number;
  /** Most array items / object keys kept per collection. Default 200. */
  readonly maxCollectionItems?: number;
}

/** Options for one {@link createLogger} call: settings override the process-wide defaults. */
export interface CreateLoggerOptions extends LoggerSettings {
  /**
   * Where lines go. Default: stdout (synchronous writes, so lines stay in order and `fatal` is on
   * stdout before the call returns), or the pino-pretty transport when `nodeEnv` is `development`
   * (flushed synchronously after `fatal`). Tests pass a capturing stream.
   */
  readonly destination?: pino.DestinationStream;
}

interface ResolvedSettings {
  readonly level: LogLevel;
  readonly nodeEnv: NodeEnv | undefined;
  readonly limits: SanitizeLimits;
}

const INITIAL_SETTINGS: ResolvedSettings = Object.freeze({
  level: 'info',
  nodeEnv: undefined,
  limits: DEFAULT_LIMITS,
});

let defaults: ResolvedSettings = INITIAL_SETTINGS;

const LIMIT_BOUNDS = {
  maxFieldBytes: { min: 64, max: 1_048_576 },
  maxDepth: { min: 1, max: 64 },
  maxCollectionItems: { min: 1, max: 10_000 },
} as const satisfies Record<keyof SanitizeLimits, { readonly min: number; readonly max: number }>;

function resolveSettings(settings: LoggerSettings, base: ResolvedSettings): ResolvedSettings {
  const level = settings.level ?? base.level;
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new ValidationError('logger level must be one of the LOG_LEVELS');
  }
  const nodeEnv = settings.nodeEnv ?? base.nodeEnv;
  if (nodeEnv !== undefined && !(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    throw new ValidationError('logger nodeEnv must be one of the NODE_ENVS');
  }
  const limits: Record<keyof SanitizeLimits, number> = { ...base.limits };
  for (const key of Object.keys(LIMIT_BOUNDS) as (keyof SanitizeLimits)[]) {
    const value = settings[key];
    if (value === undefined) continue;
    const { min, max } = LIMIT_BOUNDS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ValidationError(
        `logger ${key} must be an integer between ${String(min)} and ${String(max)}`,
      );
    }
    limits[key] = value;
  }
  return Object.freeze({ level, nodeEnv, limits: Object.freeze(limits) });
}

/**
 * Sets the process-wide defaults for every logger created afterwards. Call it once at bootstrap, right
 * after the app's config is parsed:
 *
 * ```ts
 * configureLogging({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
 * ```
 *
 * Throws `ValidationError` on an invalid setting (fail fast at boot).
 */
export function configureLogging(settings: LoggerSettings): void {
  defaults = resolveSettings(settings, defaults);
}

/** Restores the initial defaults. For tests. */
export function resetLoggingDefaults(): void {
  defaults = INITIAL_SETTINGS;
}

/** Fallback trace fields bound by `withContext({ traceId })`, read by the mixin. */
const BOUND_TRACE = Symbol('blackwing.logger.boundTrace');

type TraceCarrier = Record<typeof BOUND_TRACE, TraceFields | undefined>;

function boundTrace(logger: object): TraceFields | undefined {
  return (logger as TraceCarrier)[BOUND_TRACE];
}

function setBoundTrace(logger: object, fields: TraceFields | undefined): void {
  if (fields !== undefined) (logger as TraceCarrier)[BOUND_TRACE] = fields;
}

/** The pino-pretty transport. Development only: it runs in a worker thread, off the hot path. */
function prettyTransport(): pino.DestinationStream {
  return pino.transport({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss.l'Z'", ignore: 'pid' },
  });
}

/** Where a logger writes: the caller's stream, pino-pretty in development, else stdout. */
export function destinationKind(
  nodeEnv: NodeEnv | undefined,
  custom: boolean,
): 'custom' | 'pretty' | 'stdout' {
  if (custom) return 'custom';
  return nodeEnv === 'development' ? 'pretty' : 'stdout';
}

function openDestination(
  settings: ResolvedSettings,
  custom: pino.DestinationStream | undefined,
): pino.DestinationStream {
  if (custom !== undefined) return custom;
  if (destinationKind(settings.nodeEnv, false) === 'pretty') return prettyTransport();
  // Plain stdout, no transport in the production hot path. Synchronous on purpose: with an
  // asynchronous sonic-boom, the flushSync pino does after `fatal` can write the fatal line ahead
  // of earlier lines whose write is still in flight, and a crash can lose queued lines.
  return pino.destination({ dest: 1, sync: true });
}

function fallbackLine(name: string): string {
  return `${JSON.stringify({
    level: 'error',
    time: new Date().toISOString(),
    pid: process.pid,
    name,
    msg: 'log line dropped: redaction left it unparseable',
  })}\n`;
}

/**
 * Builds the pino options for a logger. Exported for tests; use {@link createLogger}.
 */
export function buildPinoOptions(name: string, settings: ResolvedSettings): pino.LoggerOptions {
  const { limits } = settings;
  return {
    name,
    level: settings.level,
    // Base fields: `pid` and `name` (plus `level`, `time` and trace ids per line). No hostname: the
    // log pipeline labels lines with pod/node metadata.
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    // Values reach pino already serialised by the walk (errors included); pino's own error serializer
    // would re-shape them.
    serializers: { err: (value: unknown): unknown => value },
    mixin: (_mergeObject, _level, logger) => ({ ...(activeTraceFields() ?? boundTrace(logger)) }),
    hooks: {
      // Every argument (merge object, message, format arguments) is sanitised before pino sees it.
      // `fatal` is flushed synchronously by pino itself right after this returns, for any destination
      // with `flushSync` (the pretty transport, a capturing test stream); stdout is written
      // synchronously anyway.
      logMethod(inputArgs, method) {
        const args = (inputArgs as unknown[]).map((arg, index) => {
          if (index === 0 && typeof arg === 'object' && arg !== null)
            return sanitizeRecord(arg, limits);
          return sanitize(arg, limits);
        });
        method.apply(this, args as Parameters<typeof method>);
      },
      streamWrite(line) {
        const scrubbed = redactSerializedLine(line);
        if (scrubbed === line) return line;
        try {
          JSON.parse(scrubbed);
          return scrubbed;
        } catch {
          return fallbackLine(name);
        }
      },
    },
  };
}

type ChildFn = (bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => Logger;
type SetBindingsFn = (bindings: pino.Bindings) => void;
type ChildFormatters = NonNullable<pino.ChildLoggerOptions['formatters']>;

interface SplitBindings {
  /** Sanitised bindings without `name`, `traceId` and `spanId`. */
  readonly rest: pino.Bindings;
  /** `traceId`/`spanId` bindings, kept as the mixin's fallback instead of duplicate keys. */
  readonly trace: TraceFields | undefined;
}

function splitBindings(bindings: pino.Bindings, limits: SanitizeLimits): SplitBindings {
  // `name` is fixed by createLogger (a second `name` binding would be a duplicate key); use a
  // `component` binding for sub-components.
  // A plain object again (pino calls `bindings.hasOwnProperty`); spreading keeps a `__proto__` key
  // as an own property.
  const rest: pino.Bindings = { ...sanitizeRecord(bindings, limits) };
  const { traceId, spanId } = rest;
  delete rest.traceId;
  delete rest.spanId;
  delete rest.name;
  const trace: TraceFields | undefined =
    typeof traceId === 'string' || typeof spanId === 'string'
      ? {
          ...(typeof traceId === 'string' ? { traceId } : {}),
          ...(typeof spanId === 'string' ? { spanId } : {}),
        }
      : undefined;
  return { rest, trace };
}

/**
 * A child's own serializers and formatters run after the `logMethod` hook, on values pino writes
 * as-is, so their output goes through the same walk as log arguments. A `msgPrefix` is sanitised once,
 * when the child is created. Redact paths can only be added to, never replaced.
 */
function safeChildOptions(
  options: pino.ChildLoggerOptions,
  limits: SanitizeLimits,
): pino.ChildLoggerOptions {
  const safe: pino.ChildLoggerOptions = { ...options };
  if (options.redact !== undefined) {
    const extra = Array.isArray(options.redact) ? options.redact : options.redact.paths;
    safe.redact = { paths: [...REDACT_PATHS, ...extra], censor: REDACTED };
  }
  if (options.serializers !== undefined) {
    const serializers: Record<string, pino.SerializerFn> = {};
    for (const [key, serializer] of Object.entries(options.serializers)) {
      serializers[key] = (value: unknown): unknown => sanitize(serializer(value), limits);
    }
    safe.serializers = serializers;
  }
  if (options.formatters !== undefined) {
    const { level, bindings, log } = options.formatters;
    // Plain objects again: pino calls `hasOwnProperty` on formatter results.
    const plain = (value: object): Record<string, unknown> => ({
      ...sanitizeRecord(value, limits),
    });
    const formatters: ChildFormatters = {};
    if (level !== undefined) formatters.level = (label, number) => plain(level(label, number));
    if (bindings !== undefined) formatters.bindings = (values) => plain(bindings(values));
    if (log !== undefined) formatters.log = (object) => plain(log(object));
    safe.formatters = formatters;
  }
  if (typeof options.msgPrefix === 'string') {
    safe.msgPrefix = sanitizeString(options.msgPrefix, limits);
  }
  return safe;
}

/**
 * Wraps `child` and `setBindings` on the root logger (children inherit them through the prototype
 * chain) so that bindings are sanitised like log arguments, `traceId`/`spanId` bindings become the
 * mixin's fallback instead of duplicate keys, re-binding an existing key replaces it instead of
 * repeating it, a child's own serializers, formatters and `msgPrefix` cannot bypass redaction, and a
 * child's own `redact` option can only add paths.
 */
function installChildHook(root: Logger, limits: SanitizeLimits): void {
  const originalChild = root.child.bind(root) as unknown as ChildFn;
  const proto = Object.getPrototypeOf(root) as { child: ChildFn; setBindings: SetBindingsFn };

  function setBindings(this: Logger, bindings: pino.Bindings): void {
    const { rest, trace } = splitBindings(bindings, limits);
    proto.setBindings.call(this, rest);
    setBoundTrace(this, trace);
  }

  function child(this: Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions): Logger {
    const { rest, trace } = splitBindings(bindings, limits);
    const childOptions = options === undefined ? undefined : safeChildOptions(options, limits);

    const current = this.bindings();
    const rebinding = Object.keys(rest).some((key) => Object.hasOwn(current, key));
    let instance: Logger;
    if (rebinding) {
      // pino appends child bindings, so re-binding a key would emit it twice. Rebuild from the root
      // with the merged bindings instead, keeping this logger's level.
      const merged: pino.Bindings = { ...current, ...rest };
      delete merged.name;
      instance = originalChild(merged, { level: this.level, ...childOptions });
    } else {
      instance = proto.child.call(this, rest, childOptions);
    }
    setBoundTrace(instance, trace ?? boundTrace(this));
    return instance;
  }

  Object.defineProperty(root, 'child', { value: child, writable: true, configurable: true });
  Object.defineProperty(root, 'setBindings', {
    value: setBindings,
    writable: true,
    configurable: true,
  });
}

/**
 * Creates a named logger (`name` is a base field on every line). Settings default to those given to
 * {@link configureLogging}. The first logger created also drains the buffered `config.loaded` events
 * of `@blackwing/config` at `debug`.
 */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('logger name must be a non-empty string');
  }
  const settings = resolveSettings(options, defaults);
  const safeName = sanitizeString(name, settings.limits);
  const destination = openDestination(settings, options.destination);
  const logger = pino(buildPinoOptions(safeName, settings), destination);
  installChildHook(logger, settings.limits);
  for (const event of drainConfigLoadEvents()) {
    logger.debug({ nodeEnv: event.nodeEnv, keys: event.keys }, event.msg);
  }
  return logger;
}

function contextBindings(context: LogContext): pino.Bindings {
  const bindings: pino.Bindings = {};
  for (const key of ['tenantId', 'runId', 'sessionId', 'traceId'] as const) {
    const value = context[key];
    if (typeof value === 'string' && value.length > 0) bindings[key] = value;
  }
  return bindings;
}

/**
 * Returns a child of `logger` carrying `tenantId`, `runId` and `sessionId` on every line, and `traceId`
 * as the fallback when no span is active. Children of the result inherit the context. With a
 * `tenantId` the result is a {@link TenantLogger}.
 */
export function withContext(logger: Logger, context: TenantLogContext): TenantLogger;
export function withContext(logger: Logger, context: LogContext): Logger;
export function withContext(logger: Logger, context: LogContext): Logger {
  return logger.child(contextBindings(context));
}
