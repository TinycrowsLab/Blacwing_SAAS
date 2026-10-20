import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  isAppError,
  type Redactor,
  REDACTED,
  toProblemDetails,
  ValidationError,
} from '@blackwing/errors';

import { zSecret } from './coerce.js';
import { loadConfig } from './env.js';
import { ConfigValidationError } from './errors.js';
import { markSecret, redactionRegistry } from './redaction.js';

/**
 * Value redactor over the process-wide registry, built the way `@blackwing/logger` (FOUND-008) feeds
 * the problem+json mapper: longest secret first, every occurrence replaced.
 */
const registryRedactor: Redactor = (text) =>
  [...redactionRegistry.values()]
    .sort((a, b) => b.length - a.length)
    .reduce((acc, secret) => acc.split(secret).join(REDACTED), text);

function captureConfigError(run: () => unknown): ConfigValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('ConfigValidationError as an AppError', () => {
  it('extends AppError with the registry code CONFIG_INVALID', () => {
    const error = captureConfigError(() => loadConfig(z.object({ PORT: z.string() }), {}));
    expect(error).toBeInstanceOf(AppError);
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'ConfigValidationError',
      code: 'CONFIG_INVALID',
      httpStatus: 500,
      retryable: false,
    });
    expect(error.detail).toBeUndefined();
  });

  it('maps to a generic 500 problem body that names no key and no value', () => {
    const error = captureConfigError(() =>
      loadConfig(z.object({ DATABASE_URL: z.string(), PORT: z.string() }), {}),
    );
    for (const environment of ['production', 'development'] as const) {
      const body = toProblemDetails(error, 'trace-cfg', { environment });
      expect(body).toEqual({
        type: 'https://errors.blackwing.dev/CONFIG_INVALID',
        title: 'Invalid configuration',
        status: 500,
        code: 'CONFIG_INVALID',
        traceId: 'trace-cfg',
      });
    }
  });
});

describe('problem+json detail against the real redaction registry (FOUND-009 acceptance criterion 3)', () => {
  it('never contains a value registered with markSecret, in production', () => {
    const secret = markSecret('cfg-registered-secret-0099');
    const error = new ValidationError('upstream rejected the credential', {
      detail: `The upstream rejected credential ${secret}.`,
    });
    const body = toProblemDetails(error, 'trace-1', {
      environment: 'production',
      redact: registryRedactor,
    });
    expect(body.detail).toBe(`The upstream rejected credential ${REDACTED}.`);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('never contains a secret that loadConfig registered through zSecret()', () => {
    const config = loadConfig(z.object({ PASSWORD: zSecret() }), { PASSWORD: 'pw-from-env-0100' });
    const error = new ValidationError('x', {
      detail: `bad login with ${config.PASSWORD} for user`,
    });
    const body = toProblemDetails(error, 'trace-2', {
      environment: 'production',
      redact: registryRedactor,
    });
    expect(body.detail).not.toContain('pw-from-env-0100');
  });
});
