import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  IllegalRunTransitionError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  TenantContextMissingError,
  ValidationError,
} from './app-error.js';
import { ERROR_CODE_LIST, ERROR_CODES } from './codes.js';
import {
  createProblemDetailsMapper,
  DEFAULT_MAX_DETAIL_LENGTH,
  type ErrorEnvironment,
  type ErrorLogEntry,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemDetails,
  toProblemDetails,
  toProblemResponse,
  UNKNOWN_TRACE_ID,
} from './problem.js';
import { REDACTED, type Redactor } from './redaction.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** Members RFC 9457 §3.1 defines, plus the two extension members CONTEXT_PACK §9 mandates. */
const ALLOWED_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'traceId',
]);

/**
 * Checks a body against RFC 9457 §3: a JSON object; `type` a URI reference (absolute here);
 * `status` an integer HTTP status; `title` and `detail` strings; extension members as §9 lists them.
 */
function expectRfc9457(body: ProblemDetails, status: number): void {
  // A JSON round trip, as on the wire (not a deep clone).
  const wire = JSON.stringify(body);
  const parsed = JSON.parse(wire) as Record<string, unknown>;
  expect(parsed).toEqual(body);
  for (const key of Object.keys(parsed)) expect(ALLOWED_MEMBERS.has(key)).toBe(true);
  expect(typeof parsed.type).toBe('string');
  expect(() => new URL(String(parsed.type))).not.toThrow();
  expect(parsed.status).toBe(status);
  expect(Number.isInteger(parsed.status)).toBe(true);
  expect(typeof parsed.title).toBe('string');
  expect(String(parsed.title).length).toBeGreaterThan(0);
  if ('detail' in parsed) expect(typeof parsed.detail).toBe('string');
  expect(typeof parsed.code).toBe('string');
  expect(typeof parsed.traceId).toBe('string');
}

/** A stand-in for the logger's value redactor (FOUND-008): replaces every registered secret. */
function registryRedactor(secrets: readonly string[]): Redactor {
  return (text) =>
    secrets.reduce((acc, secret) => (secret === '' ? acc : acc.split(secret).join(REDACTED)), text);
}

/** Options of a boundary wired the way the API filter wires it: the registry redactor is injected. */
const WIRED = { redact: registryRedactor([]) } as const;

describe('toProblemDetails', () => {
  it('maps a NotFoundError to a valid RFC 9457 body with status 404 (acceptance criterion 1)', () => {
    const error = new NotFoundError('asset 42 not in tenant', { detail: 'No asset with that id.' });
    const body = toProblemDetails(error, TRACE_ID, { environment: 'production', ...WIRED });
    expect(body).toEqual({
      type: 'https://errors.blackwing.dev/NOT_FOUND',
      title: 'Resource not found',
      status: 404,
      detail: 'No asset with that id.',
      code: 'NOT_FOUND',
      traceId: TRACE_ID,
    });
    expectRfc9457(body, 404);
    // Field order follows §9: type, title, status, detail, code, traceId.
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'detail', 'code', 'traceId']);

    // Called exactly as the criterion reads (no options): still a valid 404 body, minus the detail.
    const bare = toProblemDetails(error, TRACE_ID);
    expectRfc9457(bare, 404);
    expect(bare).toEqual({
      type: body.type,
      title: body.title,
      status: 404,
      code: 'NOT_FOUND',
      traceId: TRACE_ID,
    });
  });

  it.each(ERROR_CODE_LIST)(
    'maps %s to its registry status, type and title in every environment',
    (code) => {
      for (const environment of [
        'development',
        'test',
        'staging',
        'production',
        undefined,
      ] as const) {
        const options = environment === undefined ? {} : { environment };
        const body = toProblemDetails(new AppError(code, 'internal message'), TRACE_ID, options);
        expect(body.status).toBe(ERROR_CODES[code].status);
        expect(body.code).toBe(code);
        expect(body.title).toBe(ERROR_CODES[code].title);
        expect(body.type).toBe(`https://errors.blackwing.dev/${code}`);
        expectRfc9457(body, ERROR_CODES[code].status);
      }
    },
  );

  it('never uses the error message as the title or detail (title is the English v1 registry title)', () => {
    const body = toProblemDetails(
      new ForbiddenError('RBAC denied run:create for user 7 in tenant acme'),
      TRACE_ID,
    );
    expect(body.title).toBe('Forbidden');
    expect(body).not.toHaveProperty('detail');
    expect(JSON.stringify(body)).not.toContain('acme');
  });

  it('takes the status from the registry, not from a tampered httpStatus', () => {
    const error = new NotFoundError('x');
    Object.defineProperty(error, 'httpStatus', { value: 200 });
    expect(toProblemDetails(error, TRACE_ID).status).toBe(404);
  });

  it('treats an AppError whose code was tampered with as INTERNAL', () => {
    const error = new ConflictError('x', { detail: 'leak me' });
    Object.defineProperty(error, 'code', { value: 'toString' });
    const body = toProblemDetails(error, TRACE_ID, { environment: 'development' });
    expect(body).toEqual({
      type: 'https://errors.blackwing.dev/INTERNAL',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL',
      traceId: TRACE_ID,
    });
  });

  it('maps IllegalRunTransitionError to 409 with its safe state detail', () => {
    const body = toProblemDetails(
      new IllegalRunTransitionError('completed', 'running'),
      TRACE_ID,
      WIRED,
    );
    expect(body.status).toBe(409);
    expect(body.code).toBe('ILLEGAL_RUN_TRANSITION');
    expect(body.detail).toBe('A run cannot move from "completed" to "running".');
  });

  describe('trace id', () => {
    it('echoes a well-formed trace id', () => {
      expect(toProblemDetails(new NotFoundError(), '00-abc.def:1_2').traceId).toBe(
        '00-abc.def:1_2',
      );
    });

    it.each([
      ['', ''],
      ['with space', 'a b'],
      ['newline', 'abc\ndef'],
      ['markup', '<script>'],
      ['too long', 'a'.repeat(129)],
    ])("replaces a %s trace id with %j-safe 'unknown'", (_label, traceId) => {
      expect(toProblemDetails(new NotFoundError(), traceId).traceId).toBe(UNKNOWN_TRACE_ID);
    });

    it('tolerates a non-string trace id from untyped callers', () => {
      expect(toProblemDetails(new NotFoundError(), undefined as unknown as string).traceId).toBe(
        UNKNOWN_TRACE_ID,
      );
    });
  });
});

describe('production redaction (acceptance criterion 3)', () => {
  const PROD_ENVIRONMENTS: readonly (ErrorEnvironment | undefined)[] = [
    'production',
    'staging',
    undefined,
  ];

  it.each(PROD_ENVIRONMENTS)(
    'environment %s: detail never contains a registered secret',
    (environment) => {
      const secret = 's3cr3t-Value-0042';
      const redact = registryRedactor([secret]);
      const error = new ValidationError('bad', {
        detail: `Field "token" was ${secret}; expected a name.`,
      });
      const body = toProblemDetails(
        error,
        TRACE_ID,
        environment === undefined ? { redact } : { environment, redact },
      );
      expect(body.detail).toBe(`Field "token" was ${REDACTED}; expected a name.`);
      expect(JSON.stringify(body)).not.toContain(secret);
    },
  );

  it.each(PROD_ENVIRONMENTS)(
    'environment %s: detail never contains a stack trace',
    (environment) => {
      const inner = new Error('inner');
      const error = new ConflictError('x', { detail: `Conflict.\n${inner.stack ?? ''}` });
      const body = toProblemDetails(
        error,
        TRACE_ID,
        environment === undefined ? {} : { environment },
      );
      expect(body).not.toHaveProperty('detail');
      expect(JSON.stringify(body)).not.toMatch(/\bat .+:\d+:\d+/);
    },
  );

  it('drops a SpiderMonkey/JSC-style stack too', () => {
    const body = toProblemDetails(
      new ConflictError('x', { detail: 'oops\nfn@https://app/x.js:10:5' }),
      TRACE_ID,
    );
    expect(body).not.toHaveProperty('detail');
  });

  it('property: for any registered secret embedded in a 4xx detail, the production body never contains it', () => {
    fc.assert(
      fc.property(
        // No brackets: the marker itself contains them, so a secret could otherwise straddle it.
        fc
          .string({ minLength: 6, maxLength: 40 })
          .filter((s) => !s.includes('[') && !s.includes(']')),
        fc.string({ maxLength: 60 }),
        fc.string({ maxLength: 60 }),
        (secret, before, after) => {
          const error = new ValidationError('x', { detail: `${before}${secret}${after}` });
          const body = toProblemDetails(error, TRACE_ID, {
            environment: 'production',
            redact: registryRedactor([secret]),
          });
          for (const value of Object.values(body)) expect(String(value)).not.toContain(secret);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('redacts Blackwing credential formats the registry redactor does not know, and without one in development', () => {
    const detail =
      'Key bwk_live_AbC123 and bw_pat_xyz789 and bw_ci_q1 rejected; header Bearer abcdefgh12345678; url https://user:pw@host/x';
    const options = [
      { environment: 'production', ...WIRED },
      { environment: 'development' },
    ] as const;
    for (const option of options) {
      const body = toProblemDetails(new ValidationError('x', { detail }), TRACE_ID, option);
      for (const leaked of [
        'bwk_live_AbC123',
        'bw_pat_xyz789',
        'bw_ci_q1',
        'abcdefgh12345678',
        'user:pw',
      ]) {
        expect(body.detail).not.toContain(leaked);
      }
      expect(body.detail).toContain(REDACTED);
    }
  });

  it.each(PROD_ENVIRONMENTS)(
    'environment %s: fails closed when no registry redactor is injected (4xx detail dropped)',
    (environment) => {
      const secret = 'registered-but-unknown-here-0042';
      const error = new ValidationError('bad', { detail: `Field "token" was ${secret}.` });
      const body = toProblemDetails(
        error,
        TRACE_ID,
        environment === undefined ? {} : { environment },
      );
      expect(body).toEqual({
        type: 'https://errors.blackwing.dev/VALIDATION_FAILED',
        title: 'Validation failed',
        status: 422,
        code: 'VALIDATION_FAILED',
        traceId: TRACE_ID,
      });
      expect(JSON.stringify(body)).not.toContain(secret);
    },
  );

  it('withholds 5xx detail outside development/test, shows it (redacted) in development/test', () => {
    const error = new TenantContextMissingError('missing', {
      detail: 'withTenant was not called for findings.list',
    });
    for (const environment of ['production', 'staging'] as const) {
      expect(toProblemDetails(error, TRACE_ID, { environment })).not.toHaveProperty('detail');
    }
    expect(toProblemDetails(error, TRACE_ID)).not.toHaveProperty('detail');
    for (const environment of ['development', 'test'] as const) {
      expect(toProblemDetails(error, TRACE_ID, { environment }).detail).toBe(
        'withTenant was not called for findings.list',
      );
    }
  });

  it('fails closed when the injected redactor throws or returns a non-string: the detail is dropped', () => {
    const throwing: Redactor = () => {
      throw new Error('registry unavailable');
    };
    const wrongType = (() => 42) as unknown as Redactor;
    for (const redact of [throwing, wrongType]) {
      const body = toProblemDetails(
        new ValidationError('x', { detail: 'maybe secret' }),
        TRACE_ID,
        { redact },
      );
      expect(body).not.toHaveProperty('detail');
      expect(body.status).toBe(422);
    }
  });

  it('drops an empty or whitespace-only detail', () => {
    expect(
      toProblemDetails(new ValidationError('x', { detail: '   ' }), TRACE_ID),
    ).not.toHaveProperty('detail');
    expect(toProblemDetails(new ValidationError('x', { detail: '' }), TRACE_ID)).not.toHaveProperty(
      'detail',
    );
  });

  it('caps detail length after redaction without splitting a surrogate pair', () => {
    const long = toProblemDetails(
      new ValidationError('x', { detail: 'a'.repeat(5000) }),
      TRACE_ID,
      WIRED,
    );
    expect(long.detail).toHaveLength(DEFAULT_MAX_DETAIL_LENGTH);
    expect(long.detail?.endsWith('…')).toBe(true);

    const emoji = toProblemDetails(
      new ValidationError('x', { detail: `ab${'😀'.repeat(10)}` }),
      TRACE_ID,
      { ...WIRED, maxDetailLength: 4 },
    );
    expect(emoji.detail).toBe('ab…');
    // No lone surrogate left behind by the cut.
    expect(emoji.detail).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );

    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(
        toProblemDetails(new ValidationError('x', { detail: 'short' }), TRACE_ID, {
          ...WIRED,
          maxDetailLength: bad,
        }).detail,
      ).toBe('short');
    }
  });
});

describe('non-AppError values (edge case: unknown errors)', () => {
  const SECRET = 'hunter2-db-password';
  const hostile = new Proxy(new Error('x'), {
    get() {
      throw new Error('trap');
    },
    getPrototypeOf() {
      throw new Error('trap');
    },
  });
  const getterBomb = new Error('x');
  Object.defineProperty(getterBomb, 'message', {
    get() {
      throw new Error('getter');
    },
  });
  const VALUES: readonly (readonly [string, unknown])[] = [
    ['a plain Error', new Error(`connect failed: postgres://app:${SECRET}@db/x`)],
    ['a TypeError', new TypeError(`cannot read ${SECRET}`)],
    ['a string', `raw ${SECRET}`],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { message: SECRET, status: 404, code: 'NOT_FOUND' }],
    [
      'a circular object',
      (() => {
        const o: Record<string, unknown> = { secret: SECRET };
        o.self = o;
        return o;
      })(),
    ],
    ['a BigInt', 10n],
    ['a hostile Proxy', hostile],
    ['an error with a throwing getter', getterBomb],
    [
      'a fake AppError-shaped error',
      Object.assign(new Error(SECRET), { code: 'NOT_FOUND', httpStatus: 404, detail: SECRET }),
    ],
  ];

  it.each(VALUES)(
    'wraps %s as INTERNAL 500 with the generic title and no detail',
    (_label, value) => {
      for (const environment of ['production', 'development'] as const) {
        const body = toProblemDetails(value, TRACE_ID, { environment });
        expect(body).toEqual({
          type: 'https://errors.blackwing.dev/INTERNAL',
          title: 'Internal server error',
          status: 500,
          code: 'INTERNAL',
          traceId: TRACE_ID,
        });
        expect(JSON.stringify(body)).not.toContain(SECRET);
      }
    },
  );

  it('logs the real cause, redacted, without exposing it to the client', () => {
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    const error = new Error(`connect failed: token ${SECRET}`);
    const body = toProblemDetails(error, TRACE_ID, { log, redact: registryRedactor([SECRET]) });
    expect(body.code).toBe('INTERNAL');
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      level: 'error',
      code: 'INTERNAL',
      status: 500,
      traceId: TRACE_ID,
      retryable: false,
    });
    expect(entry?.err.name).toBe('Error');
    expect(entry?.err.message).toBe(`connect failed: token ${REDACTED}`);
    expect(entry?.err.stack).toContain('connect failed');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it('never throws, even for hostile input with a log sink attached', () => {
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    expect(() => toProblemDetails(hostile, TRACE_ID, { log })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('cause chains (edge case)', () => {
  it('preserves the cause chain for the log and never serialises it to the client', () => {
    const root = new Error('ECONNREFUSED 10.0.0.5:5432 password=pa55');
    const mid = new InternalError('repository failed', { cause: root });
    const top = new ConflictError('could not reserve slot', {
      cause: mid,
      detail: 'Slot already taken.',
    });
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    const body = toProblemDetails(top, TRACE_ID, { log, redact: registryRedactor(['pa55']) });

    expect(body).toEqual({
      type: 'https://errors.blackwing.dev/CONFLICT',
      title: 'Conflict',
      status: 409,
      detail: 'Slot already taken.',
      code: 'CONFLICT',
      traceId: TRACE_ID,
    });
    const wire = JSON.stringify(body);
    for (const internal of [
      'cause',
      'ECONNREFUSED',
      'repository failed',
      'could not reserve',
      'stack',
    ])
      expect(wire).not.toContain(internal);

    const entry = log.mock.calls[0]?.[0];
    expect(entry?.level).toBe('warn');
    expect(entry?.err).toMatchObject({
      name: 'ConflictError',
      code: 'CONFLICT',
      detail: 'Slot already taken.',
      message: 'could not reserve slot',
      cause: {
        name: 'InternalError',
        code: 'INTERNAL',
        message: 'repository failed',
        cause: { name: 'Error' },
      },
    });
    expect(entry?.err.cause?.cause?.message).toBe(
      `ECONNREFUSED 10.0.0.5:5432 password=${REDACTED}`,
    );
    expect(JSON.stringify(entry)).not.toContain('pa55');
  });

  it('cuts a cyclic cause chain instead of recursing forever', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b, enumerable: false });
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    expect(toProblemDetails(new InternalError('top', { cause: a }), TRACE_ID, { log }).status).toBe(
      500,
    );
    expect(log.mock.calls[0]?.[0].err.cause?.cause?.truncated).toBe('cycle');
  });
});

describe('boundary logging (observability)', () => {
  it('logs exactly once per mapped error, at warn for 4xx and error for 5xx', () => {
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    toProblemDetails(new NotFoundError('x'), TRACE_ID, { log });
    toProblemDetails(new TenantContextMissingError('x'), TRACE_ID, { log });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([entry]) => [entry.level, entry.code, entry.status])).toEqual([
      ['warn', 'NOT_FOUND', 404],
      ['warn', 'TENANT_CONTEXT_MISSING', 403],
    ]);
  });

  it('swallows a failing log sink: the client still gets its problem body', () => {
    const log = (): void => {
      throw new Error('sink down');
    };
    expect(toProblemDetails(new NotFoundError('x'), TRACE_ID, { log }).status).toBe(404);
  });

  it('records the retryable flag', () => {
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    toProblemDetails(new RateLimitedError('x'), TRACE_ID, { log });
    expect(log.mock.calls[0]?.[0].retryable).toBe(true);
  });
});

describe('toProblemResponse', () => {
  it('returns status, the problem+json content type and no-store', () => {
    const response = toProblemResponse(new NotFoundError('x'), TRACE_ID);
    expect(PROBLEM_JSON_CONTENT_TYPE).toBe('application/problem+json');
    expect(response.status).toBe(404);
    expect(response.headers).toEqual({
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    });
    expect(response.body).toEqual(toProblemDetails(new NotFoundError('x'), TRACE_ID));
  });

  it('adds Retry-After for RATE_LIMITED when the wait is known (§9)', () => {
    const response = toProblemResponse(
      new RateLimitedError('x', { retryAfterSeconds: 30 }),
      TRACE_ID,
    );
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(toProblemResponse(new RateLimitedError('x'), TRACE_ID).headers).not.toHaveProperty(
      'retry-after',
    );
  });

  it('ignores an invalid retryAfterSeconds set after construction', () => {
    const error = new RateLimitedError('x');
    Object.defineProperty(error, 'retryAfterSeconds', { value: -3 });
    expect(toProblemResponse(error, TRACE_ID).headers).not.toHaveProperty('retry-after');
  });

  it('answers 500 for an unknown thrown value', () => {
    const response = toProblemResponse(new Error('boom'), TRACE_ID);
    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
  });
});

describe('createProblemDetailsMapper', () => {
  it('binds environment, redactor and log sink once', () => {
    const log = vi.fn<(entry: ErrorLogEntry) => void>();
    const mapper = createProblemDetailsMapper({
      environment: 'production',
      redact: registryRedactor(['topsecret']),
      log,
    });
    expect(Object.isFrozen(mapper)).toBe(true);
    const body = mapper.toProblemDetails(
      new ValidationError('x', { detail: 'got topsecret' }),
      TRACE_ID,
    );
    expect(body.detail).toBe(`got ${REDACTED}`);
    expect(
      mapper.toProblemDetails(new InternalError('x', { detail: 'internal' }), TRACE_ID),
    ).not.toHaveProperty('detail');
    expect(mapper.toProblemResponse(new NotFoundError('x'), TRACE_ID).status).toBe(404);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
