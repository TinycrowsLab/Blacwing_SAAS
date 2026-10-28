import { Registry } from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { signupVerifiedSchema } from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';
import { FixedClock } from '@blackwing/time';

import { InMemorySignupStore } from './memory.js';
import { createSignupMetrics, type SignupMetrics } from './metrics.js';
import { SignupService } from './service.js';
import { hashSignupToken } from './token.js';

import type { TenantProvisioningQueue, TenantProvisioningRequest } from './ports.js';
import type { EmailMessage, EmailSender } from '@blackwing/notify';

const VERIFY_URL = 'https://app.example/signup/verify';
const EMAIL = 'owner@acme.example';

class Mailbox implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failure: Error | undefined;
  send(message: EmailMessage): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.sent.push(message);
    return Promise.resolve();
  }
}

class Provisioning implements TenantProvisioningQueue {
  readonly queued: TenantProvisioningRequest[] = [];
  failure: Error | undefined;
  enqueue(request: TenantProvisioningRequest): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.queued.push(request);
    return Promise.resolve();
  }
}

/** Log lines the service wrote, as `[message, fields]`. */
type Logged = [string, Record<string, unknown>];

let store: InMemorySignupStore;
let mailbox: Mailbox;
let provisioning: Provisioning;
let metrics: SignupMetrics;
let clock: FixedClock;
let logs: Logged[];
let service: SignupService;

function build(settings: Partial<{ emailMaxPerHour: number; tokenTtlHours: number }> = {}): void {
  store = new InMemorySignupStore();
  store.now = () => clock.now();
  mailbox = new Mailbox();
  provisioning = new Provisioning();
  metrics = createSignupMetrics(new Registry());
  logs = [];
  const base = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const capture =
    (level: 'info' | 'warn' | 'error') =>
    (fields: unknown, message?: string): void => {
      logs.push([`${level}:${message ?? ''}`, fields as Record<string, unknown>]);
    };
  service = new SignupService({
    store,
    mailer: mailbox,
    provisioning,
    metrics,
    logger: Object.assign(Object.create(base) as typeof base, {
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    }),
    clock,
    settings: {
      tokenTtlHours: settings.tokenTtlHours ?? 24,
      region: 'eu-west-1',
      verifyUrl: VERIFY_URL,
      emailMaxPerHour: settings.emailMaxPerHour ?? 5,
    },
  });
}

beforeEach(() => {
  clock = new FixedClock('2026-10-28T12:00:00.000Z');
  build();
});

/** The token in the link of the latest mail. */
function tokenOfLatestMail(): string {
  const mail = mailbox.sent.at(-1);
  const match = /#token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '');
  if (match?.[1] === undefined) throw new Error('no verification link in the mail');
  return match[1];
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : 'not-an-app-error';
  }
  return undefined;
}

describe('request', () => {
  it('stores a pending signup with only the token hash and mails the link', async () => {
    const answer = await service.request({
      email: 'Owner@Acme.Example ',
      orgName: 'Acme Security',
    });

    expect(answer).toEqual({ status: 'verification_requested' });
    expect(store.signups).toHaveLength(1);
    const row = store.signups[0];
    expect(row).toMatchObject({
      email: EMAIL,
      orgName: 'Acme Security',
      desiredSlug: 'acme-security',
      status: 'pending',
    });
    const token = tokenOfLatestMail();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.tokenHash).toBe(hashSignupToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(mailbox.sent[0]?.to).toBe(EMAIL);
    expect(mailbox.sent[0]?.text).toContain(`${VERIFY_URL}#token=${token}`);
    expect(mailbox.sent[0]?.text).toContain('24 hours');
  });

  it('expires the link after SIGNUP_TOKEN_TTL_HOURS', async () => {
    build({ tokenTtlHours: 2 });
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    expect(store.signups[0]?.expiresAt.toISOString()).toBe('2026-10-28T14:00:00.000Z');
  });

  it('answers identically whether or not the address already has an account', async () => {
    const first = await service.request({ email: EMAIL, orgName: 'Acme Security' });
    await service.verify(tokenOfLatestMail());
    expect(store.users.has(EMAIL)).toBe(true);

    const again = await service.request({ email: EMAIL, orgName: 'Acme Security' });
    const stranger = await service.request({
      email: 'new@other.example',
      orgName: 'Acme Security',
    });

    expect(again).toEqual(first);
    expect(stranger).toEqual(first);
    // The same work happened for the known and the unknown address: a row and a mail.
    expect(mailbox.sent.map((mail) => mail.to)).toEqual([EMAIL, EMAIL, 'new@other.example']);
    expect(store.signups).toHaveLength(3);
  });

  it('refuses a name with no usable slug before storing anything', async () => {
    expect(await codeOf(service.request({ email: EMAIL, orgName: '日本語の会社' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(store.signups).toHaveLength(0);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('keeps the signup pending and still answers 202 when the mail cannot be sent', async () => {
    mailbox.failure = Object.assign(new Error(`550 no such user <${EMAIL}>`), {
      code: 'EENVELOPE',
    });

    await expect(service.request({ email: EMAIL, orgName: 'Acme Security' })).resolves.toEqual({
      status: 'verification_requested',
    });

    expect(store.signups[0]?.status).toBe('pending');
    expect(await metrics.requested.get()).toMatchObject({
      values: [{ labels: { result: 'email_failed' }, value: 1 }],
    });
    const failure = logs.find(([message]) => message === 'error:signup.email_failed');
    expect(failure?.[1]).toMatchObject({ errorName: 'Error', errorCode: 'EENVELOPE' });
    expect(JSON.stringify(logs)).not.toContain(EMAIL);
  });

  it('cancels the earlier pending link when the address asks again, so only the newest works', async () => {
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    const first = tokenOfLatestMail();
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    const second = tokenOfLatestMail();

    expect(store.signups.map((row) => row.status)).toEqual(['cancelled', 'pending']);
    expect(await codeOf(service.verify(first))).toBe('SIGNUP_TOKEN_INVALID');
    await expect(service.verify(second)).resolves.toMatchObject({ outcome: 'tenant_created' });
  });

  it('rate-limits mails per address: extra requests still get the 202 but send nothing', async () => {
    build({ emailMaxPerHour: 2 });
    const answers = [];
    for (let i = 0; i < 4; i += 1) {
      answers.push(await service.request({ email: EMAIL, orgName: 'Acme Security' }));
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(mailbox.sent).toHaveLength(2);
    expect(store.signups).toHaveLength(2);
    expect(await metrics.requested.get()).toMatchObject({
      values: expect.arrayContaining([{ labels: { result: 'throttled' }, value: 2 }]) as unknown,
    });

    // An hour later the window has moved on.
    clock.advance('61m');
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    expect(mailbox.sent).toHaveLength(3);
    // Other addresses are unaffected.
    await service.request({ email: 'other@acme.example', orgName: 'Acme Security' });
    expect(mailbox.sent).toHaveLength(4);
  });

  it('never logs the address, the organisation name or the token', async () => {
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    const token = tokenOfLatestMail();
    await service.verify(token);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('Acme Security');
    expect(text).not.toContain(token);
    expect(text).toContain('emailRef');
  });
});

describe('verify', () => {
  beforeEach(async () => {
    await service.request({ email: EMAIL, orgName: 'Acme Security' });
  });

  it('creates the tenant, the owner and the membership and queues Keycloak provisioning', async () => {
    const result = await service.verify(tokenOfLatestMail());

    expect(signupVerifiedSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ outcome: 'tenant_created', slug: 'acme-security' });
    const tenantId = (result as { tenantId: string }).tenantId;
    expect(store.tenants.get('acme-security')).toEqual({
      id: tenantId,
      name: 'Acme Security',
      region: 'eu-west-1',
    });
    expect(store.memberships).toEqual([
      { tenantId, userId: store.users.get(EMAIL)?.id, roles: ['org_admin'] },
    ]);
    expect(store.signups[0]?.status).toBe('verified');
    expect(provisioning.queued).toEqual([
      { tenantId, slug: 'acme-security', name: 'Acme Security' },
    ]);
    expect(store.audit.map((event) => event.action)).toEqual(['signup.verified', 'tenant.created']);
  });

  it('is single use: a second verify of the same token is SIGNUP_TOKEN_INVALID and creates nothing', async () => {
    const token = tokenOfLatestMail();
    await service.verify(token);

    expect(await codeOf(service.verify(token))).toBe('SIGNUP_TOKEN_INVALID');
    expect(store.tenants.size).toBe(1);
    expect(store.memberships).toHaveLength(1);
    expect(provisioning.queued).toHaveLength(1);
  });

  it('creates one tenant when the same token is verified concurrently', async () => {
    const token = tokenOfLatestMail();
    const results = await Promise.allSettled([
      service.verify(token),
      service.verify(token),
      service.verify(token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.tenants.size).toBe(1);
  });

  it('rejects an expired token, marks it expired and creates nothing; a new request works', async () => {
    const token = tokenOfLatestMail();
    clock.advance('24h');

    expect(await codeOf(service.verify(token))).toBe('SIGNUP_TOKEN_INVALID');
    expect(store.signups[0]?.status).toBe('expired');
    expect(store.tenants.size).toBe(0);
    expect(store.users.size).toBe(0);

    await service.request({ email: EMAIL, orgName: 'Acme Security' });
    await expect(service.verify(tokenOfLatestMail())).resolves.toMatchObject({
      outcome: 'tenant_created',
    });
  });

  it('accepts the token while it is still within its lifetime', async () => {
    const token = tokenOfLatestMail();
    clock.advance('23h');
    await expect(service.verify(token)).resolves.toMatchObject({ outcome: 'tenant_created' });
  });

  it.each(['', 'not-a-token', 'x'.repeat(43), `${'A'.repeat(42)}%`, 'a b'])(
    'answers SIGNUP_TOKEN_INVALID for the unknown token %j',
    async (token) => {
      expect(await codeOf(service.verify(token))).toBe('SIGNUP_TOKEN_INVALID');
      expect(store.tenants.size).toBe(0);
    },
  );

  it('does not accept the stored hash as a token', async () => {
    const hash = store.signups[0]?.tokenHash ?? '';
    expect(await codeOf(service.verify(hash))).toBe('SIGNUP_TOKEN_INVALID');
  });

  it('counts invalid tokens and never says which kind it was', async () => {
    const token = tokenOfLatestMail();
    const unknown = await service.verify('nope').catch((e: unknown) => e);
    await service.verify(token);
    const used = await service.verify(token).catch((e: unknown) => e);

    expect(isAppError(unknown) && isAppError(used)).toBe(true);
    expect({ ...(unknown as object) }).toEqual({ ...(used as object) });
    expect((unknown as Error).message).toBe((used as Error).message);
    expect((await metrics.tokenInvalid.get()).values[0]?.value).toBe(2);
  });

  it('never creates a second tenant for an address that already has an account', async () => {
    const first = tokenOfLatestMail();
    await service.verify(first);
    await service.request({ email: EMAIL, orgName: 'Another Org' });

    const result = await service.verify(tokenOfLatestMail());

    expect(result).toEqual({ outcome: 'existing_account' });
    expect(store.tenants.size).toBe(1);
    expect(store.memberships).toHaveLength(1);
    expect(store.signups.at(-1)?.status).toBe('verified');
    expect(provisioning.queued).toHaveLength(1);
  });

  it('resolves a slug collision with -2, -3', async () => {
    await service.verify(tokenOfLatestMail());
    const slugs = ['acme-security'];
    for (const email of ['b@x.example', 'c@x.example']) {
      await service.request({ email, orgName: 'Acme Security' });
      const result = await service.verify(tokenOfLatestMail());
      slugs.push((result as { slug: string }).slug);
    }
    expect(slugs).toEqual(['acme-security', 'acme-security-2', 'acme-security-3']);
  });

  it('keeps the tenant when queueing provisioning fails (TENANT-005 reconciles)', async () => {
    provisioning.failure = new Error('valkey down');

    await expect(service.verify(tokenOfLatestMail())).resolves.toMatchObject({
      outcome: 'tenant_created',
    });

    expect(store.tenants.size).toBe(1);
    expect((await metrics.provisioningFailures.get()).values[0]?.value).toBe(1);
  });
});
