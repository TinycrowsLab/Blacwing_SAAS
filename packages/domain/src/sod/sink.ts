/** Structured-warning sink, compatible with a pino / `@blackwing/logger` logger (`warn(obj, msg)`). */
export interface SodWarnSink {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** Optional collaborators for the SoD primitives. Omit `logger` to refuse silently (still throws). */
export interface SodOptions {
  readonly logger?: SodWarnSink;
}
