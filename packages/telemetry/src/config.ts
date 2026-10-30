import { z } from 'zod';

import { type EnvSource, loadConfig, zBool, zString, zUrl } from '@blackwing/config';

/** Trace samplers accepted by `OTEL_TRACES_SAMPLER` (OpenTelemetry SDK environment variables). */
export const OTEL_SAMPLERS = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
] as const;
export type OtelSampler = (typeof OTEL_SAMPLERS)[number];

/** `OTEL_DEPLOYMENT_ENV` values that get the production sampling ratio by default. */
const PRODUCTION_DEPLOYMENT_ENV = 'production';
const DEV_SAMPLER_RATIO = 1.0;
/** Default metric export interval, in milliseconds. */
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 15000;
const PRODUCTION_SAMPLER_RATIO = 0.1;

const ISSUE_RATIO = 'must be a number from 0 to 1';
const ISSUE_POSITIVE_MS = 'must be a positive integer number of milliseconds';

/** A sampling ratio: decimal digits between 0 and 1 inclusive. */
function zRatio(): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    const value = /^[0-9]*\.?[0-9]+$|^[0-9]+\.$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      ctx.addIssue({ code: 'custom', message: ISSUE_RATIO });
      return z.NEVER;
    }
    return value;
  });
}

/** A positive integer count of milliseconds, as digits. */
function zPositiveMs(): z.ZodType<number, string> {
  return z.string().transform((raw, ctx): number => {
    const value = /^[1-9][0-9]{0,11}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({ code: 'custom', message: ISSUE_POSITIVE_MS });
      return z.NEVER;
    }
    return value;
  });
}

/**
 * Environment keys the telemetry bootstrap reads (CONTEXT_PACK §5, OBS-001). Every key has a default, so
 * an app with no OpenTelemetry settings still boots. The sampler ratio defaults to 1.0 outside production
 * and 0.1 in production (`OTEL_DEPLOYMENT_ENV=production`).
 */
export const telemetryConfigSchema = z.object({
  OTEL_SDK_DISABLED: zBool().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: zUrl({ protocols: ['http:', 'https:'] }).default(
    'http://otel-collector:4317',
  ),
  OTEL_DEPLOYMENT_ENV: zString().default('dev'),
  OTEL_TRACES_SAMPLER: z.enum(OTEL_SAMPLERS).default('parentbased_traceidratio'),
  OTEL_TRACES_SAMPLER_ARG: zRatio().optional(),
  OTEL_METRIC_EXPORT_INTERVAL_MS: zPositiveMs().default(DEFAULT_METRIC_EXPORT_INTERVAL_MS),
});

/** The sampler ratio: the configured `OTEL_TRACES_SAMPLER_ARG`, else 1.0 outside production and 0.1 in production. */
export function samplerRatio(config: TelemetryConfig): number {
  if (config.OTEL_TRACES_SAMPLER_ARG !== undefined) return config.OTEL_TRACES_SAMPLER_ARG;
  return config.OTEL_DEPLOYMENT_ENV === PRODUCTION_DEPLOYMENT_ENV
    ? PRODUCTION_SAMPLER_RATIO
    : DEV_SAMPLER_RATIO;
}

export type TelemetryConfig = z.output<typeof telemetryConfigSchema>;

/**
 * Parses the telemetry keys from `source` (the environment, through `@blackwing/config`). Fails closed on
 * an invalid value: the thrown `ConfigValidationError` names keys and never echoes values.
 */
export function readTelemetryConfig(source?: EnvSource): TelemetryConfig {
  return loadConfig(telemetryConfigSchema, source);
}
