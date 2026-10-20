/** Fields of the `config.loaded` debug event: key names and `NODE_ENV`, never values. */
export interface ConfigLoadedFields {
  /** `NODE_ENV` of the loaded config, when the schema has one. */
  readonly nodeEnv: string | undefined;
  /** Every resolved top-level key, sorted. */
  readonly keys: readonly string[];
}

/** A buffered `config.loaded` event. */
export interface ConfigLoadedEvent extends ConfigLoadedFields {
  readonly level: "debug";
  readonly msg: "config.loaded";
}

/**
 * Where `loadConfig` sends its `config.loaded` event. The signature matches pino's
 * `logger.debug(obj, msg)`, so a `@blackwing/logger` instance can be passed directly.
 */
export interface ConfigLogSink {
  debug(fields: ConfigLoadedFields, msg: "config.loaded"): void;
}

/** Bound on buffered events, so a process that never creates a logger cannot grow without limit. */
export const MAX_BUFFERED_CONFIG_EVENTS = 32;

const buffered: ConfigLoadedEvent[] = [];

/**
 * Records a `config.loaded` event. Config resolves before the logger exists (the logger itself reads
 * `LOG_LEVEL` and the redaction registry from config), so without a sink the event is buffered until
 * the logger drains it with {@link drainConfigLoadEvents}.
 */
export function emitConfigLoaded(fields: ConfigLoadedFields, sink: ConfigLogSink | undefined): void {
  if (sink !== undefined) {
    sink.debug(fields, "config.loaded");
    return;
  }
  if (buffered.length >= MAX_BUFFERED_CONFIG_EVENTS) {
    buffered.shift();
  }
  buffered.push(Object.freeze({ level: "debug", msg: "config.loaded", ...fields }));
}

/** Returns and clears the buffered `config.loaded` events, oldest first. */
export function drainConfigLoadEvents(): readonly ConfigLoadedEvent[] {
  return Object.freeze(buffered.splice(0, buffered.length));
}
