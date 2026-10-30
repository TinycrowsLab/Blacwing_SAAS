import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from '@blackwing/config';

import { readTelemetryConfig, samplerRatio } from './config.js';

describe('readTelemetryConfig', () => {
  it('applies the documented defaults when no OTEL_* key is set', () => {
    const config = readTelemetryConfig({});
    expect(config).toEqual({
      OTEL_SDK_DISABLED: false,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4317',
      OTEL_DEPLOYMENT_ENV: 'dev',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: undefined,
      OTEL_METRIC_EXPORT_INTERVAL_MS: 15000,
    });
    expect(samplerRatio(config)).toBe(1);
  });

  it('defaults the sampler ratio to 0.1 in production and 1.0 elsewhere', () => {
    expect(samplerRatio(readTelemetryConfig({ OTEL_DEPLOYMENT_ENV: 'production' }))).toBe(0.1);
    expect(samplerRatio(readTelemetryConfig({ OTEL_DEPLOYMENT_ENV: 'staging' }))).toBe(1);
  });

  it('honours explicit values, including an explicit ratio in production', () => {
    const config = readTelemetryConfig({
      OTEL_SDK_DISABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal:4317',
      OTEL_DEPLOYMENT_ENV: 'production',
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
      OTEL_METRIC_EXPORT_INTERVAL_MS: '5000',
    });
    expect(config.OTEL_SDK_DISABLED).toBe(true);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.internal:4317');
    expect(config.OTEL_TRACES_SAMPLER).toBe('traceidratio');
    expect(samplerRatio(config)).toBe(0.25);
    expect(config.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(5000);
  });

  it('treats an empty value as unset and takes the default', () => {
    expect(
      readTelemetryConfig({ OTEL_TRACES_SAMPLER_ARG: '' }).OTEL_TRACES_SAMPLER_ARG,
    ).toBeUndefined();
  });

  it.each([
    ['OTEL_TRACES_SAMPLER_ARG', '1.5'],
    ['OTEL_TRACES_SAMPLER_ARG', '-0.1'],
    ['OTEL_TRACES_SAMPLER_ARG', 'half'],
    ['OTEL_TRACES_SAMPLER', 'sometimes'],
    ['OTEL_METRIC_EXPORT_INTERVAL_MS', '0'],
    ['OTEL_METRIC_EXPORT_INTERVAL_MS', '15s'],
    ['OTEL_SDK_DISABLED', 'yes'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'grpc://collector:4317'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'not a url'],
  ])('refuses an invalid %s and names the key without echoing its value', (key, value) => {
    let thrown: unknown;
    try {
      readTelemetryConfig({ [key]: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((thrown as ConfigValidationError).issues)).toContain(key);
    expect((thrown as Error).message).not.toContain(value);
  });
});
