import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type Problem,
  problemSchema,
  signupAcceptedSchema,
  signupVerifiedSchema,
} from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { InMemorySignupStore } from './memory.js';
import { SignupModule } from './module.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';

import type { TenantProvisioningRequest } from './ports.js';
import type { EmailMessage, EmailSender } from '@blackwing/notify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const EMAIL = 'owner@acme.example';

let app: NestFastifyApplication;
let store: InMemorySignupStore;
let mails: EmailMessage[];
let queued: TenantProvisioningRequest[];
let keyCounter = 0;

async function boot(env: Record<string, string> = {}): Promise<void> {
  store = new InMemorySignupStore();
  mails = [];
  queued = [];
  keyCounter = 0;
  const metrics = createHttpMetrics();
  const mailer: EmailSender = {
    send(message) {
      mails.push(message);
      return Promise.resolve();
    },
  };
  const created = await createApiApp({
    config: loadApiConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      RATE_LIMIT_DEFAULT_RPS: '1000',
      RATE_LIMIT_BURST: '1000',
      ...env,
    }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    idempotencyStore: new InMemoryIdempotencyStore(),
    imports: [
      SignupModule.forRoot({
        registry: metrics.registry,
        store,
        mailer,
        provisioning: {
          enqueue(request) {
            queued.push(request);
            return Promise.resolve();
          },
        },
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
});

let addressCounter = 0;

/** A different client address per call, so the per-IP bucket of one test never blocks another request. */
const nextAddress = (): string =>
  `10.1.${String(Math.floor(++addressCounter / 250))}.${String(addressCounter % 250)}`;

function signup(
  body: unknown,
  key: string | null = `signup-key-${String(++keyCounter)}`,
  remoteAddress = nextAddress(),
) {
  return app.inject({
    method: 'POST',
    url: '/v1/signup',
    remoteAddress,
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    payload: body as object,
  });
}

function verify(body: unknown, remoteAddress = nextAddress()) {
  return app.inject({
    method: 'POST',
    url: '/v1/signup/verify',
    remoteAddress,
    headers: { 'content-type': 'application/json' },
    payload: body as object,
  });
}

function tokenOfLatestMail(): string {
  const match = /#token=([A-Za-z0-9_-]+)/.exec(mails.at(-1)?.text ?? '');
  if (match?.[1] === undefined) throw new Error('no link in the mail');
  return match[1];
}

describe('POST /v1/signup', () => {
  it('answers 202, stores a pending signup and mails the link to the console page', async () => {
    const response = await signup({ email: EMAIL, orgName: 'Acme Security' });

    expect(response.statusCode).toBe(202);
    expect(signupAcceptedSchema.parse(response.json())).toEqual({
      status: 'verification_requested',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(store.signups).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(EMAIL);
    expect(mails[0]?.text).toContain('http://localhost:3000/signup/verify#token=');
  });

  it('uses SIGNUP_VERIFY_URL when it is configured', async () => {
    await app.close();
    await boot({ SIGNUP_VERIFY_URL: 'https://console.example/join/confirm' });
    await signup({ email: EMAIL, orgName: 'Acme Security' });
    expect(mails[0]?.text).toContain('https://console.example/join/confirm#token=');
  });

  it('gives a byte-identical answer for an address that already has an account (no enumeration)', async () => {
    const fresh = await signup({ email: 'new@acme.example', orgName: 'Acme Security' });
    await signup({ email: EMAIL, orgName: 'Acme Security' });
    await verify({ token: tokenOfLatestMail() });
    expect(store.users.has(EMAIL)).toBe(true);

    const known = await signup({ email: EMAIL, orgName: 'Acme Security' });

    expect(known.statusCode).toBe(fresh.statusCode);
    expect(known.body).toBe(fresh.body);
    expect(
      Object.fromEntries(
        Object.entries(known.headers).filter(([k]) => /^(content-|cache-)/.test(k)),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(fresh.headers).filter(([k]) => /^(content-|cache-)/.test(k)),
      ),
    );
  });

  it('requires an Idempotency-Key', async () => {
    const response = await signup({ email: EMAIL, orgName: 'Acme Security' }, null);
    expect(response.statusCode).toBe(400);
    expect(problemSchema.parse(response.json()).code).toBe('idempotency_key_required');
    expect(store.signups).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it('replays a repeated Idempotency-Key without a second row or mail', async () => {
    const first = await signup({ email: EMAIL, orgName: 'Acme Security' }, 'same-key-0001');
    const replay = await signup({ email: EMAIL, orgName: 'Acme Security' }, 'same-key-0001');

    expect(replay.statusCode).toBe(202);
    expect(replay.body).toBe(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(store.signups).toHaveLength(1);
    expect(mails).toHaveLength(1);
  });

  it('refuses the same Idempotency-Key with a different body', async () => {
    await signup({ email: EMAIL, orgName: 'Acme Security' }, 'same-key-0002');
    const response = await signup(
      { email: 'x@acme.example', orgName: 'Acme Security' },
      'same-key-0002',
    );
    expect(response.statusCode).toBe(409);
    expect(problemSchema.parse(response.json()).code).toBe('idempotency_conflict');
    expect(store.signups).toHaveLength(1);
  });

  it.each([
    ['a missing email', { orgName: 'Acme Security' }],
    ['an invalid email', { email: 'not-an-email', orgName: 'Acme Security' }],
    ['a one-character name', { email: EMAIL, orgName: 'A' }],
    ['a name over 100 characters', { email: EMAIL, orgName: 'x'.repeat(101) }],
    ['a name that trims to one character', { email: EMAIL, orgName: '  A  ' }],
    ['control characters in the name', { email: EMAIL, orgName: 'Acme\r\nBcc: evil@x.example' }],
    ['an unknown field', { email: EMAIL, orgName: 'Acme Security', role: 'org_admin' }],
    ['a name with no usable slug', { email: EMAIL, orgName: '日本語の会社' }],
  ])('rejects %s with 422 and sends nothing', async (_label, body) => {
    const response = await signup(body);
    expect(response.statusCode).toBe(422);
    expect(problemSchema.parse(response.json()).code).toBe('validation_failed');
    expect(store.signups).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it('does not echo the address or the name in an error body', async () => {
    const response = await signup({ email: 'leaky@acme.example', orgName: 'A' });
    expect(response.body).not.toContain('leaky@acme.example');
  });

  it('rate-limits an anonymous client by IP', async () => {
    await app.close();
    await boot({ RATE_LIMIT_DEFAULT_RPS: '1', RATE_LIMIT_BURST: '1' });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(
        (
          await signup(
            { email: `u${String(i)}@acme.example`, orgName: 'Acme' },
            `limit-key-${String(i)}`,
            '203.0.113.9',
          )
        ).statusCode,
      );
    }
    // The route's own bucket (burst 5) applies, not the generous default.
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses.slice(5)).toContain(429);
  });
});

describe('POST /v1/signup/verify', () => {
  beforeEach(async () => {
    await signup({ email: EMAIL, orgName: 'Acme Security' });
  });

  it('creates the tenant and answers 200 with its id and slug', async () => {
    const response = await verify({ token: tokenOfLatestMail() });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = signupVerifiedSchema.parse(response.json());
    expect(body).toMatchObject({ outcome: 'tenant_created', slug: 'acme-security' });
    expect(store.tenants.get('acme-security')?.id).toBe((body as { tenantId: string }).tenantId);
    expect(queued).toHaveLength(1);
    expect(store.audit.map((event) => event.action)).toEqual(['signup.verified', 'tenant.created']);
  });

  it('answers 400 SIGNUP_TOKEN_INVALID problem+json for a used token and creates nothing more', async () => {
    const token = tokenOfLatestMail();
    await verify({ token });

    const second = await verify({ token });

    expect(second.statusCode).toBe(400);
    expect(second.headers['content-type']).toContain('application/problem+json');
    const problem: Problem = problemSchema.parse(second.json());
    expect(problem.code).toBe('signup_token_invalid');
    expect(store.tenants.size).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it('answers the same SIGNUP_TOKEN_INVALID for an unknown token', async () => {
    const response = await verify({ token: 'a'.repeat(43) });
    expect(response.statusCode).toBe(400);
    expect(problemSchema.parse(response.json()).code).toBe('signup_token_invalid');
    expect(store.tenants.size).toBe(0);
  });

  it('is not an oracle: unknown, used and cancelled tokens look the same', async () => {
    const used = tokenOfLatestMail();
    await verify({ token: used });
    await signup({ email: 'b@acme.example', orgName: 'B Corp' });
    const cancelled = tokenOfLatestMail();
    await signup({ email: 'b@acme.example', orgName: 'B Corp' });

    const bodies = await Promise.all(
      [used, cancelled, 'z'.repeat(43)].map(async (token) => {
        const response = await verify({ token });
        const rest = response.json<Record<string, unknown>>();
        delete rest.traceId;
        return { status: response.statusCode, rest };
      }),
    );
    const first = JSON.stringify(bodies[0]);
    expect(bodies.map((b) => JSON.stringify(b))).toEqual([first, first, first]);
  });

  it.each([
    ['a missing token', {}],
    ['an empty token', { token: '' }],
    ['a token over 512 characters', { token: 'a'.repeat(513) }],
    ['a non-string token', { token: 12345 }],
    ['an unknown field', { token: 'a'.repeat(43), tenantId: 'x' }],
  ])('rejects %s with 422', async (_label, body) => {
    const response = await verify(body);
    expect(response.statusCode).toBe(422);
    expect(store.tenants.size).toBe(0);
  });

  it('answers existing_account, not a second tenant, for an address that has an account', async () => {
    await verify({ token: tokenOfLatestMail() });
    await signup({ email: EMAIL, orgName: 'Second Org' });

    const response = await verify({ token: tokenOfLatestMail() });

    expect(response.statusCode).toBe(200);
    expect(signupVerifiedSchema.parse(response.json())).toEqual({ outcome: 'existing_account' });
    expect(store.tenants.size).toBe(1);
  });
});
