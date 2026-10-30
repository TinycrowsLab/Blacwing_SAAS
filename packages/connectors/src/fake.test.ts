import { describe, expect, it } from 'vitest';

import { ConnectorNotFoundError } from './errors.js';
import { FAKE_PROVIDER, FAKE_WEBHOOK_SIGNATURE_HEADER, FakeConnector } from './fake.js';

import type { ResolvedConnectorConfig, TicketPayload, TicketRef } from './types.js';

const SECRET = 'cred-test-7f3a9c2e';

const cfg: ResolvedConnectorConfig = {
  provider: FAKE_PROVIDER,
  credential: SECRET,
  settings: { project: 'SEC' },
};

const payload: TicketPayload = {
  title: 'SQL injection in /search',
  bodyMarkdown: '## Summary\n\nUser input reaches the query.',
  severity: 'high',
  labels: ['security', 'blackwing'],
};

function bodyWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'ticket.status_changed',
    externalId: 'FAKE-1',
    status: 'resolved',
    ...overrides,
  });
}

async function createOne(connector: FakeConnector): Promise<TicketRef> {
  return connector.createTicket(cfg, payload);
}

describe('FakeConnector round trip', () => {
  it('creates a ticket and returns a normalised ref with the fake provider and project', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    expect(ref).toEqual({
      provider: FAKE_PROVIDER,
      externalId: 'FAKE-1',
      url: 'https://fake.invalid/tickets/FAKE-1',
      projectKeyOrRepo: 'SEC',
    });
  });

  it('gets a created ticket as open, then reflects a status change made upstream', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    await expect(connector.getTicket(cfg, ref)).resolves.toEqual({ status: 'open', url: ref.url });
    connector.setStatus(ref.externalId, 'in_progress');
    await expect(connector.getTicket(cfg, ref)).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('applies a patch to a ref after creation (partial upstream failure is repaired later)', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    await expect(
      connector.updateTicket(cfg, ref, { bodyMarkdown: 'full body' }),
    ).resolves.toBeUndefined();
    await expect(connector.getTicket(cfg, ref)).resolves.toMatchObject({ status: 'open' });
  });

  it('issues distinct ids for distinct tickets', async () => {
    const connector = new FakeConnector();
    const first = await createOne(connector);
    const second = await createOne(connector);
    expect(second.externalId).not.toBe(first.externalId);
  });

  it('testConnection succeeds with a credential', async () => {
    await expect(new FakeConnector().testConnection(cfg)).resolves.toEqual({
      ok: true,
      accountLabel: 'fake',
    });
  });
});

describe('FakeConnector input validation', () => {
  it.each([
    ['empty title', { title: '   ' }],
    ['title over the limit', { title: 'x'.repeat(256) }],
    ['body over the limit', { bodyMarkdown: 'x'.repeat(65_537) }],
    ['unknown severity band', { severity: 'extreme' }],
    ['unknown extra key', { cvss: 9.8 }],
    ['too many labels', { labels: Array.from({ length: 51 }, (_, i) => `l${i}`) }],
    ['empty label', { labels: [''] }],
    ['empty priority', { priority: '' }],
    ['non-string field value', { fields: { severity: 9 } }],
  ])('refuses a create with %s as CONNECTOR_VALIDATION', async (_label, override) => {
    await expect(
      new FakeConnector().createTicket(cfg, {
        ...payload,
        ...override,
      } as unknown as TicketPayload),
    ).rejects.toMatchObject({ code: 'CONNECTOR_VALIDATION' });
  });

  it('accepts optional priority and fields when they are well formed', async () => {
    const ref = await new FakeConnector().createTicket(cfg, {
      ...payload,
      priority: 'P1',
      fields: { assetId: 'ast_1' },
    });
    expect(ref.externalId).toBe('FAKE-1');
  });

  it('refuses an empty patch and a patch with a bad field', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    await expect(connector.updateTicket(cfg, ref, {})).rejects.toMatchObject({
      code: 'CONNECTOR_VALIDATION',
    });
    await expect(
      connector.updateTicket(cfg, ref, { severity: 'nope' } as unknown as Partial<TicketPayload>),
    ).rejects.toMatchObject({ code: 'CONNECTOR_VALIDATION' });
  });
});

describe('FakeConnector tenancy and reference checks', () => {
  it('reports a ticket it does not hold as CONNECTOR_NOT_FOUND on get and update', async () => {
    const connector = new FakeConnector();
    const ghost: TicketRef = {
      provider: FAKE_PROVIDER,
      externalId: 'FAKE-404',
      url: 'https://fake.invalid/tickets/FAKE-404',
      projectKeyOrRepo: 'SEC',
    };
    await expect(connector.getTicket(cfg, ghost)).rejects.toMatchObject({
      code: 'CONNECTOR_NOT_FOUND',
    });
    await expect(connector.updateTicket(cfg, ghost, { title: 'x' })).rejects.toMatchObject({
      code: 'CONNECTOR_NOT_FOUND',
    });
  });

  it('never resolves a ticket through another project, so one project cannot touch another', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    const otherProject: ResolvedConnectorConfig = { ...cfg, settings: { project: 'OPS' } };
    const foreignRef: TicketRef = { ...ref, projectKeyOrRepo: 'OPS' };
    await expect(connector.getTicket(otherProject, foreignRef)).rejects.toMatchObject({
      code: 'CONNECTOR_NOT_FOUND',
    });
    await expect(
      connector.updateTicket(otherProject, foreignRef, { title: 'x' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_NOT_FOUND' });
  });

  it('refuses a ref that names another provider even when the id exists here', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    await expect(connector.getTicket(cfg, { ...ref, provider: 'jira' })).rejects.toMatchObject({
      code: 'CONNECTOR_NOT_FOUND',
    });
  });

  it('defaults the project when the config names none', async () => {
    const connector = new FakeConnector();
    const ref = await connector.createTicket({ ...cfg, settings: {} }, payload);
    expect(ref.projectKeyOrRepo).toBe('default');
  });

  it('setStatus on an unknown ticket is CONNECTOR_NOT_FOUND', () => {
    expect(() => {
      new FakeConnector().setStatus('FAKE-9', 'closed');
    }).toThrow(ConnectorNotFoundError);
  });
});

describe('FakeConnector credentials (fail closed, no secret leaks)', () => {
  it('refuses every operation with an empty credential as CONNECTOR_AUTH_FAILED', async () => {
    const connector = new FakeConnector();
    const empty: ResolvedConnectorConfig = { ...cfg, credential: '' };
    await expect(connector.testConnection(empty)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED',
    });
    await expect(connector.createTicket(empty, payload)).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED',
    });
  });

  it('keeps the credential out of every error message', async () => {
    const connector = new FakeConnector();
    const ref = await createOne(connector);
    const attempts = [
      connector.verifyWebhook(cfg, { [FAKE_WEBHOOK_SIGNATURE_HEADER]: 'wrong' }, bodyWith({})),
      connector.verifyWebhook(cfg, {}, bodyWith({})),
      connector.getTicket(cfg, { ...ref, externalId: 'FAKE-999' }),
      connector.createTicket(cfg, { ...payload, title: '' }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeDefined();
      expect(JSON.stringify(error)).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});

describe('FakeConnector webhooks', () => {
  const signed = { [FAKE_WEBHOOK_SIGNATURE_HEADER]: SECRET };

  it('emits a status-changed event for a correctly signed status payload', async () => {
    await expect(new FakeConnector().verifyWebhook(cfg, signed, bodyWith({}))).resolves.toEqual({
      kind: 'ticket.status_changed',
      provider: FAKE_PROVIDER,
      externalId: 'FAKE-1',
      status: 'resolved',
    });
  });

  it('returns null for an irrelevant but authentic payload, not an error', async () => {
    await expect(
      new FakeConnector().verifyWebhook(cfg, signed, JSON.stringify({ type: 'ping' })),
    ).resolves.toBeNull();
  });

  it('refuses a missing signature before it reads the body', async () => {
    await expect(new FakeConnector().verifyWebhook(cfg, {}, bodyWith({}))).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED',
    });
    await expect(new FakeConnector().verifyWebhook(cfg, {}, 'not json')).rejects.toMatchObject({
      code: 'CONNECTOR_AUTH_FAILED',
    });
  });

  it('refuses a wrong signature, including a prefix of the credential', async () => {
    const connector = new FakeConnector();
    await expect(
      connector.verifyWebhook(
        cfg,
        { [FAKE_WEBHOOK_SIGNATURE_HEADER]: SECRET.slice(0, 5) },
        bodyWith({}),
      ),
    ).rejects.toMatchObject({ code: 'CONNECTOR_AUTH_FAILED' });
    await expect(
      connector.verifyWebhook(cfg, { [FAKE_WEBHOOK_SIGNATURE_HEADER]: `${SECRET}x` }, bodyWith({})),
    ).rejects.toMatchObject({ code: 'CONNECTOR_AUTH_FAILED' });
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"ticket.status_changed"'],
  ])('refuses %s as CONNECTOR_VALIDATION', async (_label, body) => {
    await expect(new FakeConnector().verifyWebhook(cfg, signed, body)).rejects.toMatchObject({
      code: 'CONNECTOR_VALIDATION',
    });
  });

  it.each([
    ['an unknown status', { status: 'archived' }],
    ['a missing externalId', { externalId: undefined }],
    ['an empty externalId', { externalId: '' }],
    ['an extra field', { severity: 'high' }],
  ])('refuses a relevant payload with %s as CONNECTOR_VALIDATION', async (_label, overrides) => {
    await expect(
      new FakeConnector().verifyWebhook(cfg, signed, bodyWith(overrides)),
    ).rejects.toMatchObject({ code: 'CONNECTOR_VALIDATION' });
  });
});
