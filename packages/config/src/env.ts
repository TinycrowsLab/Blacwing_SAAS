import { writeSync } from 'node:fs';

import { type ConfigIssue, ConfigValidationError } from './errors.js';
import { type ConfigLogSink, emitConfigLoaded } from './events.js';
import { describeIssue, describeSubPath } from './issues.js';

import type { z } from 'zod';

/** A raw environment: `process.env` or a plain record of strings. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /**
   * Receives the `config.loaded` debug event (key names and `NODE_ENV`, no values). When omitted the
   * event is buffered for `@blackwing/logger` to drain once it exists.
   */
  readonly log?: ConfigLogSink;
}

/** What {@link defineConfig} does when the environment is invalid. */
export type InvalidConfigAction = 'throw' | 'exit';

/** Options for {@link defineConfig}. */
export interface DefineConfigOptions extends LoadConfigOptions {
  /** Environment to read. Defaults to `process.env`. */
  readonly source?: EnvSource;
  /**
   * `exit`: write the problems (key names only) to stderr and exit with {@link CONFIG_EXIT_CODE}.
   * `throw`: throw the `ConfigValidationError`.
   * Default: `throw` when the raw `NODE_ENV` is `test`, otherwise `exit` (fail closed at bootstrap).
   */
  readonly onInvalid?: InvalidConfigAction;
}

/** Exit status of a process that refused to start on invalid configuration (sysexits `EX_CONFIG`). */
export const CONFIG_EXIT_CODE = 78;

/** Key used for issues that are not attached to a single environment key (schema-level refinements). */
const ROOT_KEY = '(root)';

interface NormalisedEnv {
  readonly input: Record<string, string>;
  readonly emptyKeys: ReadonlySet<string>;
}

/**
 * Copies the string-valued entries of `source` into a fresh object. An empty string counts as unset:
 * a required key set to `""` is reported as `empty`, and an optional key set to `""` takes its
 * default. `Object.fromEntries` defines own properties, so a key such as `__proto__` cannot reach the
 * prototype.
 */
function normalise(source: EnvSource): NormalisedEnv {
  const entries: [string, string][] = [];
  const emptyKeys = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (value === '') {
      emptyKeys.add(key);
    } else {
      entries.push([key, value]);
    }
  }
  return { input: Object.fromEntries(entries), emptyKeys };
}

function toConfigIssue(issue: z.core.$ZodIssue, env: NormalisedEnv): ConfigIssue {
  const [head, ...rest] = issue.path;
  if (head === undefined) {
    return { key: ROOT_KEY, reason: 'invalid', message: describeIssue(issue) };
  }
  const key = `${String(head)}${describeSubPath(rest)}`;
  const topKey = String(head);
  // Any issue on a key that is not set means "required but not set" (or set to ""). Zod reports
  // this as invalid_type for most schemas but as invalid_value for enums, so match on presence.
  if (rest.length === 0 && !Object.hasOwn(env.input, topKey)) {
    const reason = env.emptyKeys.has(topKey) ? 'empty' : 'missing';
    return {
      key,
      reason,
      message: reason === 'empty' ? 'required but empty' : 'required but not set',
    };
  }
  return { key, reason: 'invalid', message: describeIssue(issue) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function describeLoaded(config: unknown): { nodeEnv: string | undefined; keys: readonly string[] } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { nodeEnv: undefined, keys: Object.freeze([]) };
  }
  const nodeEnv: unknown = (config as Record<string, unknown>).NODE_ENV;
  return {
    nodeEnv: typeof nodeEnv === 'string' ? nodeEnv : undefined,
    keys: Object.freeze(Object.keys(config).sort()),
  };
}

/**
 * Parses `source` with `schema` and returns the result deeply frozen.
 *
 * - Every problem is collected and thrown at once as a {@link ConfigValidationError} that names keys
 *   but never echoes a value.
 * - Synchronous: once it returns, every `zSecret`/`zSecretUrl` value (and every URL password) is in
 *   the redaction registry, before any logger or database client is created.
 * - On success a single `config.loaded` debug event lists the resolved keys and `NODE_ENV`.
 */
export function loadConfig<T>(
  schema: z.ZodType<T>,
  source: EnvSource = process.env,
  options: LoadConfigOptions = {},
): Readonly<T> {
  const env = normalise(source);
  const result = schema.safeParse(env.input);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues.map((issue) => toConfigIssue(issue, env)));
  }
  const config = deepFreeze(result.data);
  emitConfigLoaded(describeLoaded(config), options.log);
  return config;
}

function reportAndExit(error: ConfigValidationError): never {
  const line = JSON.stringify({
    level: 'fatal',
    name: '@blackwing/config',
    msg: 'config.invalid',
    code: error.code,
    issues: error.issues,
  });
  // Synchronous write to fd 2: the logger does not exist yet, and an asynchronous stream could lose the
  // line when the process exits immediately after.
  writeSync(2, `${line}\n`);
  process.exit(CONFIG_EXIT_CODE);
}

/**
 * App bootstrap entry point: call it at module scope of the app's `config.ts` so the environment is
 * parsed exactly once, at import, before anything else starts.
 *
 * ```ts
 * export const config = defineConfig(baseEnvSchema.extend({ PORT: zPort() }));
 * ```
 *
 * Fails closed: on invalid configuration the process exits non-zero ({@link CONFIG_EXIT_CODE}) after
 * writing the problems (key names only) to stderr. Under `NODE_ENV=test` it throws instead.
 */
export function defineConfig<T>(
  schema: z.ZodType<T>,
  options: DefineConfigOptions = {},
): Readonly<T> {
  const source = options.source ?? process.env;
  try {
    return loadConfig(schema, source, options);
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) {
      throw error;
    }
    const action = options.onInvalid ?? (source.NODE_ENV === 'test' ? 'throw' : 'exit');
    if (action === 'throw') {
      throw error;
    }
    return reportAndExit(error);
  }
}
