import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defineConfig,
  baseEnvSchema,
  markSecret,
  unmarkSecret,
  zSecret,
  zUrl,
} from '@blackwing/config';
import { createProblemDetailsMapper, InternalError } from '@blackwing/errors';

import { createLogger, withContext } from './logger.js';
import {
  isSensitiveKey,
  REDACTED,
  redactSerializedLine,
  redactText,
  registerSecretPattern,
  secretPatternNames,
} from './redaction.js';
import { capture } from './testdata/capture.js';

/** Secrets registered by a test; removed again afterwards so tests stay independent. */
const registered: string[] = [];

function secret(value: string): string {
  markSecret(value);
  registered.push(value);
  return value;
}

afterEach(() => {
  for (const value of registered.splice(0)) unmarkSecret(value);
});

function setup() {
  const out = capture();
  const log = createLogger('redaction-test', { destination: out.destination, level: 'trace' });
  return { out, log };
}

describe('value redaction (registry from @blackwing/config)', () => {
  it('never emits a registered secret, wherever it appears in the logged object', () => {
    const value = secret('s3cr3t-value-0001');
    const { out, log } = setup();
    log.info(
      {
        plain: value,
        nested: { deeper: { list: ['x', value, { again: value }] } },
        [value]: 'secret as a key name',
        map: new Map([['k', value]]),
        set: new Set([value]),
      },
      `message with ${value}`,
    );
    const text = out.text();
    expect(text).not.toContain(value);
    const record = out.last();
    expect(record.plain).toBe(REDACTED);
    expect(record.msg).toBe(`message with ${REDACTED}`);
    expect(record).toHaveProperty([REDACTED], 'secret as a key name');
    expect(record.nested).toEqual({ deeper: { list: ['x', REDACTED, { again: REDACTED }] } });
  });

  it('redacts secrets registered by config parsing (zSecret, URL passwords)', () => {
    const config = defineConfig(baseEnvSchema.extend({ API_TOKEN: zSecret(), UPSTREAM: zUrl() }), {
      source: {
        NODE_ENV: 'test',
        API_TOKEN: 'tok-from-config-0002',
        UPSTREAM: 'https://svc:pw-in-url-0002@up.local/x',
      },
    });
    registered.push(config.API_TOKEN, 'pw-in-url-0002');
    const { out, log } = setup();
    log.info({ cfg: config }, 'config dump %s', config.API_TOKEN);
    expect(out.text()).not.toContain('tok-from-config-0002');
    expect(out.text()).not.toContain('pw-in-url-0002');
  });

  it('catches a secret inside a larger string or URL (proxy URL bwk_…@egress)', () => {
    const key = secret('vk-embedded-0003');
    const { out, log } = setup();
    log.info(
      { proxy: `http://${key}@egress:13128`, query: `/v1/x?k=${key}&y=1` },
      'proxy configured',
    );
    log.info({ proxy: 'http://bwk_AbC123xyz_-9@egress:13128' }, 'virtual key by pattern');
    expect(out.text()).not.toContain(key);
    expect(out.text()).not.toContain('bwk_AbC123xyz_-9');
    const [first, second] = out.records();
    expect(first?.proxy).toBe(`http://${REDACTED}@egress:13128`);
    expect(first?.query).toBe(`/v1/x?k=${REDACTED}&y=1`);
    expect(String(second?.proxy)).toContain(REDACTED);
  });

  it('redacts format arguments (%s, %j, %o) and child bindings', () => {
    const value = secret('fmt-secret-0004');
    const { out, log } = setup();
    log.info('a %s b %j c %o', value, { k: value }, { k: [value] });
    log.child({ upstream: `user:${value}` }).info('bound');
    withContext(log, { tenantId: value }).info('context');
    expect(out.text()).not.toContain(value);
    expect(out.records()).toHaveLength(3);
  });

  it('redacts error messages, stacks, causes and extra error fields', () => {
    const value = secret('err-secret-0005');
    const { out, log } = setup();
    const cause = new Error(`connect failed with ${value}`);
    const err = Object.assign(new Error(`outer ${value}`, { cause }), {
      config: { header: value },
      errno: -111,
    });
    log.error(err);
    log.error(
      { err: new InternalError(`internal ${value}`, { detail: `detail ${value}` }) },
      'mapped',
    );
    expect(out.text()).not.toContain(value);
    const [first, second] = out.records();
    expect(first).toMatchObject({
      msg: `outer ${REDACTED}`,
      err: { name: 'Error', message: `outer ${REDACTED}`, errno: -111 },
    });
    expect(first?.err).toMatchObject({ cause: { message: `connect failed with ${REDACTED}` } });
    expect((first?.err as { stack: string }).stack).toContain('outer');
    expect(second?.err).toMatchObject({ code: 'INTERNAL', detail: `detail ${REDACTED}` });
  });

  it('stops redacting a value once it is unregistered (revoked), and starts when registered (issued)', () => {
    const { out, log } = setup();
    const value = 'rotating-cred-0006';
    log.info(value);
    markSecret(value);
    registered.push(value);
    log.info(value);
    unmarkSecret(value);
    log.info(value);
    expect(out.records().map((r) => r.msg)).toEqual([value, REDACTED, value]);
  });

  it('redacts a virtual model key from issue to revoke even after it leaves the registry (bwk_ pattern)', () => {
    const { out, log } = setup();
    const key = 'bwk_01JABCDEFGHJKMNPQRSTVWXYZ';
    markSecret(key);
    log.info({ key }, 'issued');
    unmarkSecret(key);
    log.info({ key }, 'revoked');
    expect(out.text()).not.toContain(key);
  });

  it('replaces the longest secret first when secrets overlap', () => {
    secret('abc-overlap-0007');
    secret('abc-overlap-0007-and-more');
    expect(redactText('x abc-overlap-0007-and-more y')).toBe(`x ${REDACTED} y`);
  });

  it('compares Unicode secrets by exact code units', () => {
    const composed = secret('pässwörd-ключ-\u{1f511}-0008');
    const { out, log } = setup();
    log.info({ v: `before ${composed} after` }, composed);
    expect(out.text()).not.toContain(composed);
    expect(out.last()).toMatchObject({ v: `before ${REDACTED} after`, msg: REDACTED });

    // The canonically equivalent decomposed form is a different byte sequence and a different value.
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(redactText(decomposed)).toBe(decomposed);
    secret(decomposed);
    expect(redactText(`${composed}|${decomposed}`)).toBe(`${REDACTED}|${REDACTED}`);
  });

  it('redacts secrets containing JSON-escaped characters (quotes, backslashes, control characters)', () => {
    const value = secret('q"uo\\te\nnew\u0001line-0009');
    const { out, log } = setup();
    log.info({ v: value }, `msg ${value}`);
    const escaped = JSON.stringify(value).slice(1, -1);
    expect(out.text()).not.toContain(escaped);
    expect(out.last()).toMatchObject({ v: REDACTED, msg: `msg ${REDACTED}` });
  });

  // Generous timeout: the full workspace suite runs many packages in parallel on a shared machine.
  it(
    'property: no registered secret ever appears in the output, in any surrounding text',
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 24, unit: 'binary' }),
          fc.string({ maxLength: 40, unit: 'binary' }),
          fc.string({ maxLength: 40, unit: 'binary' }),
          (body, before, after) => {
            // A fixed prefix keeps the secret from coinciding with fixed output such as "info".
            const value = `Zq9${body}`;
            markSecret(value);
            try {
              const { out, log } = setup();
              log.info({ field: `${before}${value}${after}`, [value]: 1 }, `${after}${value}`);
              const line = out.lines[0] ?? '';
              const parsed = JSON.parse(line) as Record<string, unknown>;
              expect(line).not.toContain(value);
              expect(line).not.toContain(JSON.stringify(value).slice(1, -1));
              expect(JSON.stringify(parsed)).not.toContain(JSON.stringify(value).slice(1, -1));
              expect(String(parsed.field)).not.toContain(value);
            } finally {
              unmarkSecret(value);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

describe('path and key-name redaction', () => {
  it('redacts the authorization header and a password field by path', () => {
    const { out, log } = setup();
    log.info(
      {
        headers: {
          authorization: 'Bearer abcdefgh12345678',
          cookie: 'sid=abc',
          accept: 'text/html',
        },
        req: { headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: 'sid=def' } },
        password: 'hunter2-top',
        user: { password: 'hunter2-nested', token: 't0k3n-nested', name: 'alice' },
      },
      'request',
    );
    const record = out.last();
    expect(record.headers).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      accept: 'text/html',
    });
    expect(record.req).toEqual({ headers: { authorization: REDACTED, cookie: REDACTED } });
    expect(record.password).toBe(REDACTED);
    expect(record.user).toEqual({ password: REDACTED, token: REDACTED, name: 'alice' });
    for (const leak of ['abcdefgh12345678', 'dXNlcjpwYXNz', 'hunter2', 't0k3n', 'sid=']) {
      expect(out.text()).not.toContain(leak);
    }
  });

  it('redacts sensitive key names at any depth and in any case or separator style', () => {
    const { out, log } = setup();
    log.info({
      a: {
        b: {
          c: {
            d: {
              clientSecret: 'x1',
              'X-Api-Key': 'x2',
              private_key: 'x3',
              signature: 'x4',
              apiKey: 'x5',
            },
          },
        },
      },
      list: [{ Authorization: 'x6' }, { 'set-cookie': ['x7'] }],
      refreshToken: 'x8',
      credentials: { user: 'u', pass: 'x9' },
    });
    for (let i = 1; i <= 9; i += 1) expect(out.text()).not.toContain(`"x${String(i)}"`);
  });

  it('keeps non-secret look-alikes visible: token counts, secret references, boolean flags', () => {
    const { out, log } = setup();
    log.info({
      inputTokens: 1200,
      outputTokens: 300,
      secretRef: 'openbao:kv/app#db',
      hasPassword: true,
      tokenId: 'tok_1',
    });
    expect(out.last()).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      secretRef: 'openbao:kv/app#db',
      hasPassword: true,
      tokenId: 'tok_1',
    });
  });

  it('keeps the built-in pino paths when a child sets its own redact option (custom serializer output)', () => {
    const { out, log } = setup();
    const child = log.child(
      {},
      { redact: ['custom'], serializers: { blob: () => ({ password: 'from-serializer', ok: 1 }) } },
    );
    child.info({ blob: 1, custom: 'custom-value' });
    expect(out.last()).toMatchObject({ blob: { password: REDACTED, ok: 1 }, custom: REDACTED });
    expect(out.text()).not.toContain('from-serializer');
  });

  it("sanitises a child's own serializer and formatter output and its msgPrefix", () => {
    const { out, log } = setup();
    const child = log.child(
      {},
      {
        msgPrefix: 'Bearer prefix0token0value ',
        serializers: {
          req: () => ({
            auth: 'Bearer serializer0token0value',
            clientSecret: 's1',
            big: 'x'.repeat(20_000),
          }),
        },
        formatters: {
          log: (object) => ({
            ...object,
            fromFormatter: 'Basic Zm9ybWF0dGVyOnBhc3M=',
            apiKey: 's2',
          }),
          bindings: (bindings) => ({ ...bindings, privateKey: 's3' }),
        },
      },
    );
    child.info({ req: 1 }, 'hello');
    const text = out.text();
    for (const leak of [
      'prefix0token0value',
      'serializer0token0value',
      'Zm9ybWF0dGVyOnBhc3M=',
      '"s1"',
      '"s2"',
      '"s3"',
    ]) {
      expect(text).not.toContain(leak);
    }
    const record = out.last();
    expect(record.msg).toBe('Bearer [REDACTED] hello');
    expect(record.req).toMatchObject({ auth: REDACTED, clientSecret: REDACTED });
    expect((record.req as { big: string }).big.endsWith('[truncated]')).toBe(true);
  });

  it('sanitises setBindings like child bindings', () => {
    const value = secret('setbindings-secret-0001');
    const { out, log } = setup();
    const child = log.child({ component: 'c' });
    child.setBindings({
      clientSecret: 'plain-client-secret',
      header: 'Bearer setbindings0token',
      echo: value,
      traceId: 'trace-from-setbindings',
    });
    child.info('after');
    const text = out.text();
    expect(text).not.toContain('plain-client-secret');
    expect(text).not.toContain('setbindings0token');
    expect(text).not.toContain(value);
    expect(out.last()).toMatchObject({
      component: 'c',
      clientSecret: REDACTED,
      echo: REDACTED,
      traceId: 'trace-from-setbindings',
    });
    expect(text.match(/"traceId"/g)).toHaveLength(1);
  });

  it('classifies key names', () => {
    for (const key of [
      'password',
      'PASSWORD',
      'db_password',
      'x-auth-token',
      'accessToken',
      'pwd',
      'Cookie',
      'set-cookie',
      'AWS_SECRET_ACCESS_KEY',
      'secretKey',
      'encryption_key',
      'jwtSigningKey',
      'auth',
      'JWT',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of [
      'inputTokens',
      'secretRef',
      'tokenId',
      'username',
      'signatureValid',
      'authority',
      'author',
      'accessKeyId',
      'publicKey',
      'jwtIssuer',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('built-in credential shapes are redacted even when unregistered', () => {
    const { out, log } = setup();
    log.info(
      {
        pat: 'bw_pat_0123456789abcdef',
        ci: 'bw_ci_fedcba9876543210',
        run: 'bw_run_eyJydW4iOjF9.c2lnbmF0dXJlMTIz',
        auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig',
        dsn: 'postgres://bw:pw-in-dsn@db:5432/bw',
        pem: '-----BEGIN PRIVATE KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----',
      },
      'shapes',
    );
    for (const leak of [
      '0123456789abcdef',
      'fedcba9876543210',
      'eyJydW4iOjF9',
      'c2lnbmF0dXJlMTIz',
      'eyJhbGciOiJIUzI1NiJ9',
      'pw-in-dsn',
      'MIIBVQ',
    ]) {
      expect(out.text()).not.toContain(leak);
    }
  });
});

describe('registerSecretPattern', () => {
  it('registers the Blackwing credential prefixes by default', () => {
    expect(secretPatternNames()).toEqual(
      expect.arrayContaining([
        'virtual-model-key',
        'personal-access-token',
        'ci-token',
        'run-token',
      ]),
    );
  });

  it('adds a pattern, applies it to every line, and removes it again', () => {
    const remove = registerSecretPattern('acme-key', /acme_[0-9a-f]{8}/i);
    const { out, log } = setup();
    log.info({ k: 'ACME_DEADBEEF and acme_01234567' });
    expect(out.last().k).toBe(`${REDACTED} and ${REDACTED}`);
    expect(remove()).toBe(true);
    expect(remove()).toBe(false);
    log.info({ k: 'acme_01234567' });
    expect(out.last().k).toBe('acme_01234567');
  });

  it('rejects a pattern that matches the empty string, and an empty name', () => {
    expect(() => registerSecretPattern('everything', /x*/)).toThrow(/empty string/);
    expect(() => registerSecretPattern('', /x/)).toThrow(/name/);
  });
});

describe('serialised-line safety net', () => {
  it('leaves a clean line untouched (same reference)', () => {
    const line = '{"level":"info","msg":"ok"}\n';
    expect(redactSerializedLine(line)).toBe(line);
  });

  it('redacts a secret that only appears after formatting joined two pieces', () => {
    const value = secret('joined-secret-0010');
    const { out, log } = setup();
    log.info('joined-%s', 'secret-0010');
    expect(out.text()).not.toContain(value);
  });

  it('drops a line whose redaction would break JSON, writing a parseable notice instead', () => {
    secret('":"');
    const { out, log } = setup();
    log.info({ a: 'b' }, 'structural');
    const record = out.last();
    expect(record).toMatchObject({ level: 'error', name: 'redaction-test' });
    expect(String(record.msg)).toMatch(/dropped/);
  });
});

describe('integration with the @blackwing/errors mapper', () => {
  it('redactText is the redactor the problem+json mapper needs: no registered secret in body or log', () => {
    const value = secret('mapper-secret-0011');
    const { out, log } = setup();
    const mapper = createProblemDetailsMapper({
      environment: 'development',
      redact: redactText,
      log: (entry) => {
        log[entry.level](entry, 'request failed');
      },
    });
    const body = mapper.toProblemDetails(
      new InternalError(`boom ${value}`, { detail: `detail ${value}` }),
      'trace-1',
    );
    expect(JSON.stringify(body)).not.toContain(value);
    expect(out.text()).not.toContain(value);
    expect(out.last()).toMatchObject({ level: 'error', code: 'INTERNAL', status: 500 });
  });
});
