import { describe, expect, it } from 'vitest';

import { serviceInstrumentations } from './instrumentations.js';

describe('serviceInstrumentations', () => {
  it('registers exactly the HTTP, NestJS core, pg and ioredis subset', () => {
    const names = serviceInstrumentations().map(
      (instrumentation) => instrumentation.instrumentationName,
    );
    expect(names.sort()).toEqual(
      [
        '@opentelemetry/instrumentation-http',
        '@opentelemetry/instrumentation-ioredis',
        '@opentelemetry/instrumentation-nestjs-core',
        '@opentelemetry/instrumentation-pg',
      ].sort(),
    );
  });

  it('returns fresh instances on every call, so apps never share patch state', () => {
    const [first] = serviceInstrumentations();
    const [second] = serviceInstrumentations();
    expect(first).not.toBe(second);
  });
});
