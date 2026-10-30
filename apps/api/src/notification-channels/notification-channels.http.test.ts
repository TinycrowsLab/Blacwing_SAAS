import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { NotificationChannelsModule } from './module.js';

import type { ChannelMemberships, ChannelSecretSealer, NotificationChannelStore } from './ports.js';
import type { NotificationChannelRow } from '@blackwing/db';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * HTTP contract of `/v1/notification-channels` (NOTIFY-001) against an in-memory store and sealer: the
 * authorisation, the validation, the credential handling (by reference, never in the config or a response),
 * the conflicts and the fail-closed KEK path. The Postgres adapter and RLS are proven in
 * `packages/db/src/notification-channel.rls.int.test.ts`.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ORG_ADMIN = randomUUID();
const APPSEC = randomUUID();
const DEVELOPER = randomUUID();
const ADMIN_B = randomUUID();
const OUTSIDER = randomUUID();

const SLACK_URL = 'https://hooks.slack.com/services/T0000/B0000/SECRETTOKENVALUE';
const PAGERDUTY_KEY = 'pd-integration-key-9f8e7d6c5b4a';

const USERS: Record<string, string> = {
  'admin-a': ORG_ADMIN,
  'appsec-a': APPSEC,
  'developer-a': DEVELOPER,
  'admin-b': ADMIN_B,
  'outsider-a': OUTSIDER,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

const ROLES: Record<string, Record<string, readonly string[]>> = {
  [TENANT_A]: {
    [ORG_ADMIN]: ['org_admin'],
    [APPSEC]: ['appsec_engineer'],
    [DEVELOPER]: ['developer'],
  },
  [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
};

/** Test IAM: the principal comes from a header the test controls, never the body. Format `<user>@<tenant>`. */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

/** An in-memory channel store with the repository's semantics: tenant-scoped, unique names, a locked update. */
function memoryStore(): NotificationChannelStore & {
  rows: Map<string, NotificationChannelRow>;
  shredded: Set<string>;
  creates: number;
} {
  const rows = new Map<string, NotificationChannelRow>();
  const shredded = new Set<string>();
  const store = {
    rows,
    shredded,
    creates: 0,
    list: (tenantId: string) =>
      Promise.resolve([...rows.values()].filter((row) => row.tenantId === tenantId)),
    find: (tenantId: string, id: string) =>
      Promise.resolve(rows.get(id)?.tenantId === tenantId ? rows.get(id) : undefined),
    create: (tenantId: string, write: Parameters<NotificationChannelStore['create']>[1]) => {
      store.creates += 1;
      const taken = [...rows.values()].some(
        (row) => row.tenantId === tenantId && row.name === write.name,
      );
      if (taken) return Promise.reject(new AppError('CHANNEL_NAME_CONFLICT', 'name in use'));
      const now = new Date();
      const row: NotificationChannelRow = {
        id: write.id,
        tenantId,
        kind: write.kind,
        name: write.name,
        config: write.config,
        secretRef: write.secret?.ref ?? null,
        status: write.status,
        createdBy: write.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    update: (
      tenantId: string,
      id: string,
      mutate: Parameters<NotificationChannelStore['update']>[2],
    ) => {
      const current = rows.get(id);
      if (current?.tenantId !== tenantId) {
        return Promise.reject(new AppError('NOT_FOUND'));
      }
      const write = mutate(current);
      if (write === undefined) return Promise.resolve({ record: current, changed: false });
      if (write.status === 'active' && current.secretRef !== null) {
        const secretId = current.secretRef.split('/').pop() ?? '';
        if (shredded.has(secretId)) {
          return Promise.reject(new AppError('CHANNEL_SECRET_UNAVAILABLE'));
        }
      }
      const next: NotificationChannelRow = {
        ...current,
        ...(write.name === undefined ? {} : { name: write.name }),
        ...(write.config === undefined ? {} : { config: write.config }),
        ...(write.status === undefined ? {} : { status: write.status }),
        updatedAt: new Date(),
      };
      rows.set(id, next);
      return Promise.resolve({ record: next, changed: true });
    },
  };
  return store;
}

/** A sealer that records every plaintext it is given, so tests can prove none leaks. */
function recordingSealer(): ChannelSecretSealer & {
  plaintexts: string[];
  down: boolean;
  contexts: string[];
} {
  const sealer = {
    plaintexts: [] as string[],
    contexts: [] as string[],
    down: false,
    encryptSecret: ({
      plaintext,
      context,
    }: Parameters<ChannelSecretSealer['encryptSecret']>[0]) => {
      if (sealer.down) return Promise.reject(new AppError('KEK_UNAVAILABLE'));
      sealer.plaintexts.push(plaintext);
      sealer.contexts.push(context.secretId);
      return Promise.resolve({
        v: 1,
        alg: 'AES-256-GCM',
        kekKey: 'kek',
        kekVersion: 1,
        wrappedDek: 'vault:v1:dek',
        iv: 'iv',
        tag: 'tag',
        ct: 'ct',
        aadHash: 'hash',
      } as const);
    },
  };
  return sealer;
}

const memberships: ChannelMemberships = {
  rolesOf: (tenantId, userId) => Promise.resolve(ROLES[tenantId]?.[userId] ?? []),
};

/** Captures every structured log line, so a test can prove no credential reaches the log. */
function capturingLogger(lines: string[]): Logger {
  const base = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const sink = {
    info: (obj: unknown, msg?: string) => lines.push(JSON.stringify(obj) + (msg ?? '')),
  };
  return Object.assign(Object.create(base) as Logger, sink);
}

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let store: ReturnType<typeof memoryStore>;
let sealer: ReturnType<typeof recordingSealer>;
let logLines: string[];
let referencing: string[];

beforeEach(async () => {
  metrics = createHttpMetrics();
  store = memoryStore();
  sealer = recordingSealer();
  logLines = [];
  referencing = [];
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      NotificationChannelsModule.forRoot({
        store,
        memberships,
        secrets: sealer,
        references: { activeRuleIds: () => Promise.resolve(referencing) },
        logger: capturingLogger(logLines),
        registry: metrics.registry,
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const url = '/v1/notification-channels';

/** The problem `code` is serialised in lower case; compare the registry code. */
const codeOf = (res: { json(): unknown }): string =>
  (res.json() as { code: string }).code.toUpperCase();
const as = (principal: string) => ({ 'x-test-principal': principal });

const slackBody = (name = 'Gate alerts') => ({
  kind: 'slack',
  name,
  config: { channel: 'appsec-alerts' },
  secret: SLACK_URL,
});

async function createSlack(principal = 'admin-a@a', name = 'Gate alerts') {
  return app.inject({ method: 'POST', url, headers: as(principal), payload: slackBody(name) });
}

describe('POST /v1/notification-channels', () => {
  it('stores the Slack webhook URL by reference and never returns or logs it', async () => {
    const res = await createSlack();
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('secret');
    expect(body.secretRef).toMatch(new RegExp(`^bw-secret://${TENANT_A}/`));
    expect(body.config).toEqual({ channel: 'appsec-alerts' });
    const stored = [...store.rows.values()][0];
    expect(JSON.stringify(stored?.config)).not.toContain(SLACK_URL);
    expect(sealer.plaintexts).toEqual([SLACK_URL]);
    expect(res.body).not.toContain(SLACK_URL);
    expect(logLines.join('\n')).not.toContain(SLACK_URL);
  });

  it('gives the credential a fresh secret id and binds the envelope to it', async () => {
    const res = await createSlack();
    const ref = res.json<{ secretRef: string }>().secretRef;
    expect(sealer.contexts).toEqual([ref.split('/').pop()]);
  });

  it('allows an email channel with no credential and refuses one that carries a secret', async () => {
    const ok = await app.inject({
      method: 'POST',
      url,
      headers: as('admin-a@a'),
      payload: { kind: 'email', name: 'SOC mail', config: { addresses: ['soc@example.test'] } },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ secretRef: unknown }>().secretRef).toBeNull();
    const bad = await app.inject({
      method: 'POST',
      url,
      headers: as('admin-a@a'),
      payload: {
        kind: 'email',
        name: 'SOC mail 2',
        config: { addresses: ['soc@example.test'] },
        secret: 'x',
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers 400 with field paths only, and refuses a credential smuggled into config', async () => {
    const smuggled = await app.inject({
      method: 'POST',
      url,
      headers: as('admin-a@a'),
      payload: {
        kind: 'slack',
        name: 'x',
        config: { channel: 'a', webhookUrl: SLACK_URL },
        secret: SLACK_URL,
      },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(codeOf(smuggled)).toBe('NOTIFICATION_CHANNEL_INVALID');
    expect(smuggled.body).not.toContain(SLACK_URL);
    const unknownKind = await app.inject({
      method: 'POST',
      url,
      headers: as('admin-a@a'),
      payload: { kind: 'sms', name: 'x', config: {} },
    });
    expect(unknownKind.statusCode).toBe(400);
    expect(store.creates).toBe(0);
    expect(sealer.plaintexts).toEqual([]);
  });

  it('answers 409 CHANNEL_NAME_CONFLICT for a name already used, after NFC normalisation', async () => {
    expect((await createSlack('admin-a@a', 'Café')).statusCode).toBe(201);
    const dup = await createSlack('admin-a@a', 'Café');
    expect(dup.statusCode).toBe(409);
    expect(codeOf(dup)).toBe('CHANNEL_NAME_CONFLICT');
    expect(store.rows.size).toBe(1);
  });

  it('refuses a name with control characters', async () => {
    const res = await createSlack('admin-a@a', 'bad\nname');
    expect(res.statusCode).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it('fails closed when the tenant key or OpenBao is down: 503 and nothing persisted', async () => {
    sealer.down = true;
    const res = await createSlack();
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('KEK_UNAVAILABLE');
    expect(store.rows.size).toBe(0);
    expect(store.creates).toBe(0);
  });

  it('refuses a caller without notifications:manage (403), including a developer and an outsider', async () => {
    for (const principal of ['developer-a@a', 'outsider-a@a']) {
      const res = await createSlack(principal);
      expect(res.statusCode, principal).toBe(403);
    }
    expect(store.rows.size).toBe(0);
  });

  it('lets appsec_engineer manage channels too (RBAC grant)', async () => {
    expect((await createSlack('appsec-a@a')).statusCode).toBe(201);
  });
});

describe('reads and tenant isolation', () => {
  it('lists the tenant channels and hides another tenant’s channel from every read', async () => {
    const created = await createSlack();
    const id = created.json<{ id: string }>().id;
    const list = await app.inject({ method: 'GET', url, headers: as('appsec-a@a') });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    const other = await app.inject({
      method: 'GET',
      url: `${url}/${id}`,
      headers: as('admin-b@b'),
    });
    expect(other.statusCode).toBe(404);
    const patch = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-b@b'),
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode).toBe(404);
    expect([...store.rows.values()][0]?.status).toBe('active');
  });

  it('answers 404 for a malformed channel id and a missing one', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `${url}/not-a-uuid`, headers: as('admin-a@a') }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `${url}/${randomUUID()}`, headers: as('admin-a@a') }))
        .statusCode,
    ).toBe(404);
  });

  it('refuses reads to a developer (403)', async () => {
    const res = await app.inject({ method: 'GET', url, headers: as('developer-a@a') });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /v1/notification-channels/{id}', () => {
  it('disables and re-enables delivery, and a repeated disable is a no-op', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    const off = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'disabled' },
    });
    expect(off.json<{ status: string }>().status).toBe('disabled');
    const again = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'disabled' },
    });
    expect(again.statusCode).toBe(200);
    const on = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'active' },
    });
    expect(on.json<{ status: string }>().status).toBe('active');
  });

  it('will not enable a channel whose credential was shredded (409 CHANNEL_SECRET_UNAVAILABLE)', async () => {
    const created = await createSlack();
    const id = created.json<{ id: string }>().id;
    const ref = created.json<{ secretRef: string }>().secretRef;
    await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'disabled' },
    });
    store.shredded.add(ref.split('/').pop() ?? '');
    const res = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('CHANNEL_SECRET_UNAVAILABLE');
  });

  it('rotates the credential to a new version of the same secret, keeping the ref', async () => {
    const created = await createSlack();
    const id = created.json<{ id: string }>().id;
    const ref = created.json<{ secretRef: string }>().secretRef;
    const newUrl = 'https://hooks.slack.com/services/T0000/B0000/ROTATEDTOKEN';
    const res = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { secret: newUrl },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ secretRef: string }>().secretRef).toBe(ref);
    expect(sealer.plaintexts.at(-1)).toBe(newUrl);
    expect(sealer.contexts.at(-1)).toBe(ref.split('/').pop());
    expect(res.body).not.toContain(newUrl);
    expect(logLines.join('\n')).not.toContain(newUrl);
  });

  it('re-validates config for the kind and refuses a secret for a kind that has none', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    const smuggle = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { config: { token: 'abc' } },
    });
    expect(smuggle.statusCode).toBe(400);
    const emailId = (
      await app.inject({
        method: 'POST',
        url,
        headers: as('admin-a@a'),
        payload: { kind: 'email', name: 'SOC', config: { addresses: ['soc@example.test'] } },
      })
    ).json<{ id: string }>().id;
    const noSecret = await app.inject({
      method: 'PATCH',
      url: `${url}/${emailId}`,
      headers: as('admin-a@a'),
      payload: { secret: 'x' },
    });
    expect(noSecret.statusCode).toBe(400);
  });

  it('refuses a kind change (strict body) and a PATCH from a developer (403)', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    const kind = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { kind: 'email' },
    });
    expect(kind.statusCode).toBe(400);
    const dev = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('developer-a@a'),
      payload: { status: 'disabled' },
    });
    expect(dev.statusCode).toBe(403);
  });

  it('counts a committed change once, and a no-op not at all', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: {},
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain('bw_notification_channel_changes_total{kind="slack",op="created"} 1');
    expect(text).not.toContain('op="updated"');
    await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
      payload: { status: 'disabled' },
    });
    expect(await metrics.registry.metrics()).toContain(
      'bw_notification_channel_changes_total{kind="slack",op="disabled"} 1',
    );
  });
});

describe('DELETE /v1/notification-channels/{id}', () => {
  it('soft-disables by default and keeps the row and its credential reference', async () => {
    const created = await createSlack();
    const id = created.json<{ id: string }>().id;
    const res = await app.inject({
      method: 'DELETE',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; secretRef: string }>()).toMatchObject({
      status: 'disabled',
      secretRef: created.json<{ secretRef: string }>().secretRef,
    });
    expect(store.rows.size).toBe(1);
  });

  it('blocks disabling a channel that routing rules reference, and names the rules', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    const ruleId = randomUUID();
    referencing = [ruleId];
    const res = await app.inject({
      method: 'DELETE',
      url: `${url}/${id}`,
      headers: as('admin-a@a'),
    });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('CHANNEL_REFERENCED');
    expect(res.json<{ detail: string }>().detail).toContain(ruleId);
    expect([...store.rows.values()][0]?.status).toBe('active');
  });

  it('disables a referenced channel when force=true is sent', async () => {
    const id = (await createSlack()).json<{ id: string }>().id;
    referencing = [randomUUID()];
    const res = await app.inject({
      method: 'DELETE',
      url: `${url}/${id}?force=true`,
      headers: as('admin-a@a'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('disabled');
  });

  it('answers 404 for an unknown channel and 403 for a developer', async () => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${url}/${randomUUID()}`,
          headers: as('admin-a@a'),
        })
      ).statusCode,
    ).toBe(404);
    const id = (await createSlack()).json<{ id: string }>().id;
    expect(
      (await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: as('developer-a@a') }))
        .statusCode,
    ).toBe(403);
  });
});

describe('the audit and telemetry of a change', () => {
  it('logs only ids, the kind and the op', async () => {
    await createSlack();
    const line = logLines.find((entry) => entry.includes('notification_channel.changed')) ?? '';
    expect(line).toContain('"op":"created"');
    expect(line).toContain('"kind":"slack"');
    expect(line).not.toContain('Gate alerts');
    expect(line).not.toContain(SLACK_URL);
  });

  it('keeps the PagerDuty key out of every response (the check is the same for all secret kinds)', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as('admin-a@a'),
      payload: {
        kind: 'pagerduty',
        name: 'Pager',
        config: { region: 'eu' },
        secret: PAGERDUTY_KEY,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PAGERDUTY_KEY);
    expect(sealer.plaintexts).toEqual([PAGERDUTY_KEY]);
  });
});
