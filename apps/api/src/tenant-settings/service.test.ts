import { describe, expect, it } from 'vitest';

import { hashTenantId } from '@blackwing/db/tenant-context';
import {
  ForbiddenError,
  PreconditionFailedError,
  PreconditionRequiredError,
  REDACTED,
  ValidationError,
} from '@blackwing/errors';

import {
  ADMIN_A,
  ADMIN_B,
  AUDITOR_A,
  BASE_TIME,
  memoryMemberships,
  memoryStore,
  recordOf,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { TenantSettingsService } from './service.js';
import { parseStoredSettings, tenantSettingsEtag } from './settings.js';
import { ApiProblemError } from '../errors/problem-errors.js';

const ADMIN = { tenantId: TENANT_A, actorId: ADMIN_A };
const AUDITOR = { tenantId: TENANT_A, actorId: AUDITOR_A };

function harness(settings: Record<string, unknown> = {}) {
  const store = memoryStore({
    [TENANT_A]: recordOf(settings),
    [TENANT_B]: recordOf({ displayTimezone: 'Asia/Tokyo' }),
  });
  const memberships = memoryMemberships({
    [TENANT_A]: { [ADMIN_A]: ['org_admin'], [AUDITOR_A]: ['auditor'] },
    [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
  });
  const logs: { payload: unknown; message: string }[] = [];
  const counts = { updated: 0 };
  const service = new TenantSettingsService({
    store,
    memberships,
    metrics: {
      updated: () => {
        counts.updated += 1;
      },
    },
    logger: {
      info: (payload: unknown, message?: string) => {
        logs.push({ payload, message: message ?? '' });
      },
    } as never,
  });
  return { service, store, logs, counts };
}

/** The ETag a client holds after a GET of the current state. */
async function currentEtag(service: TenantSettingsService, principal = ADMIN): Promise<string> {
  return (await service.get(principal)).etag;
}

describe('TenantSettingsService.get', () => {
  it('returns the settings with defaults, the read-only region and a strong ETag', async () => {
    const { service } = harness({});
    const view = await service.get(ADMIN);
    expect(view.body).toEqual({
      settings: { displayTimezone: 'UTC', defaultAssessmentMode: 'grey' },
      region: 'eu-west-1',
      updatedAt: new Date(BASE_TIME).toISOString(),
    });
    expect(view.etag).toBe(tenantSettingsEtag(parseStoredSettings({}), new Date(BASE_TIME)));
  });

  it('lets any member read (an auditor too), but not a membership with no roles', async () => {
    const { service } = harness();
    await expect(service.get(AUDITOR)).resolves.toBeDefined();
    const stranger = { tenantId: TENANT_A, actorId: '0198f0a0-0000-7000-8000-0000000000ff' };
    await expect(service.get(stranger)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a caller whose user id is not a UUID (fail closed, no lookup)', async () => {
    const { service } = harness();
    await expect(service.get({ tenantId: TENANT_A, actorId: 'usr_1' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('is tenant-scoped: an admin of tenant A has no rights in tenant B', async () => {
    const { service } = harness();
    await expect(service.get({ tenantId: TENANT_B, actorId: ADMIN_A })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('TenantSettingsService.update', () => {
  it('requires If-Match: a missing header is 428 and nothing is read or written', async () => {
    const { service, store } = harness();
    await expect(
      service.update(ADMIN, undefined, { displayTimezone: 'Europe/Berlin' }),
    ).rejects.toBeInstanceOf(PreconditionRequiredError);
    await expect(
      service.update(ADMIN, '   ', { displayTimezone: 'Europe/Berlin' }),
    ).rejects.toBeInstanceOf(PreconditionRequiredError);
    expect(store.mutations.count).toBe(0);
  });

  it('answers 428 for a weak ETag, which is not a valid precondition', async () => {
    const { service, store } = harness();
    await expect(service.update(ADMIN, 'W/"abc"', {})).rejects.toBeInstanceOf(
      PreconditionRequiredError,
    );
    expect(store.mutations.count).toBe(0);
  });

  it('checks the body only after the precondition header (428 before 422)', async () => {
    const { service } = harness();
    await expect(service.update(ADMIN, undefined, { region: 'us-east-1' })).rejects.toBeInstanceOf(
      PreconditionRequiredError,
    );
  });

  it('applies the change with the current ETag, audits it and counts it', async () => {
    const { service, store, counts, logs } = harness();
    const etag = await currentEtag(service);
    const view = await service.update(ADMIN, etag, { displayTimezone: 'Europe/Berlin' });
    expect(view.body.settings.displayTimezone).toBe('Europe/Berlin');
    expect(view.etag).not.toBe(etag);
    expect(store.audits).toEqual([
      {
        tenantId: TENANT_A,
        actorId: ADMIN_A,
        changes: { displayTimezone: { from: 'UTC', to: 'Europe/Berlin' } },
      },
    ]);
    expect(counts.updated).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe('tenant_settings.updated');
    // The log names the tenant by its hash and the changed keys, never a value or the raw tenant id.
    expect(logs[0]?.payload).toEqual({
      tenantId: hashTenantId(TENANT_A),
      changedKeys: ['displayTimezone'],
    });
    expect(JSON.stringify(logs)).not.toContain(TENANT_A);
  });

  it('refuses a stale ETag with 412 and changes nothing (lost-update protection)', async () => {
    const { service, store, counts } = harness();
    const stale = await currentEtag(service);
    await service.update(ADMIN, stale, { weekStartsOn: 1 });
    await expect(
      service.update(ADMIN, stale, { displayTimezone: 'Asia/Tokyo' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(store.rows.get(TENANT_A)?.settings).toEqual({
      displayTimezone: 'UTC',
      defaultAssessmentMode: 'grey',
      weekStartsOn: 1,
    });
    expect(store.audits).toHaveLength(1);
    expect(counts.updated).toBe(1);
  });

  it('accepts If-Match: * as "the resource must exist"', async () => {
    const { service } = harness();
    const view = await service.update(ADMIN, '*', { defaultAssessmentMode: 'white' });
    expect(view.body.settings.defaultAssessmentMode).toBe('white');
  });

  it('refuses an unknown zone with invalid_timezone and writes nothing', async () => {
    const { service, store } = harness();
    const etag = await currentEtag(service);
    const error: unknown = await service
      .update(ADMIN, etag, { displayTimezone: 'Mars/Olympus' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).problemCode).toBe('invalid_timezone');
    expect(store.audits).toEqual([]);
  });

  it.each([
    ['an unknown key (setting smuggling)', { isAdmin: true }],
    ['region (read-only)', { region: 'us-east-1' }],
  ])('refuses %s with a validation error and writes nothing', async (_label, body) => {
    const { service, store } = harness();
    const etag = await currentEtag(service);
    await expect(service.update(ADMIN, etag, body)).rejects.toBeInstanceOf(ValidationError);
    expect(store.audits).toEqual([]);
  });

  it('treats an empty patch as a no-op: same ETag, no write, no audit, no count', async () => {
    const { service, store, counts } = harness({ displayTimezone: 'Europe/Berlin' });
    const etag = await currentEtag(service);
    const view = await service.update(ADMIN, etag, {});
    expect(view.etag).toBe(etag);
    expect(store.audits).toEqual([]);
    expect(counts.updated).toBe(0);
  });

  it('treats a patch that sets the current values as a no-op', async () => {
    const { service, store } = harness({ displayTimezone: 'Europe/Berlin' });
    const etag = await currentEtag(service);
    const view = await service.update(ADMIN, etag, {
      displayTimezone: 'Europe/Berlin',
      defaultAssessmentMode: 'grey',
    });
    expect(view.etag).toBe(etag);
    expect(store.audits).toEqual([]);
  });

  it('redacts a notification e-mail in the audit diff, keeping the key', async () => {
    const { service, store, logs } = harness();
    const etag = await currentEtag(service);
    await service.update(ADMIN, etag, { defaultNotificationEmail: 'secops@example.com' });
    expect(store.audits[0]?.changes).toEqual({
      defaultNotificationEmail: { from: null, to: REDACTED },
    });
    expect(JSON.stringify(store.audits)).not.toContain('secops@example.com');
    expect(JSON.stringify(logs)).not.toContain('secops@example.com');
  });

  it('clears an optional key with null and audits it', async () => {
    const { service, store } = harness({ defaultNotificationEmail: 'ops@example.com' });
    const etag = await currentEtag(service);
    const view = await service.update(ADMIN, etag, { defaultNotificationEmail: null });
    expect(view.body.settings).not.toHaveProperty('defaultNotificationEmail');
    expect(store.audits[0]?.changes).toEqual({
      defaultNotificationEmail: { from: REDACTED, to: null },
    });
  });

  it('refuses a read-only role (auditor) with 403 and writes nothing', async () => {
    const { service, store } = harness();
    const etag = await currentEtag(service);
    await expect(service.update(AUDITOR, etag, { weekStartsOn: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(store.mutations.count).toBe(0);
  });

  it('cross-tenant PATCH is denied: an admin of tenant B cannot change tenant A', async () => {
    const { service, store } = harness();
    const etag = await currentEtag(service);
    await expect(
      service.update({ tenantId: TENANT_A, actorId: ADMIN_B }, etag, { weekStartsOn: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.rows.get(TENANT_A)?.settings).toEqual({});
    expect(store.audits).toEqual([]);
  });

  it('a change in tenant B does not touch tenant A (the write is scoped to the caller tenant)', async () => {
    const { service, store } = harness();
    const etagB = await service.get({ tenantId: TENANT_B, actorId: ADMIN_B }).then((v) => v.etag);
    await service.update({ tenantId: TENANT_B, actorId: ADMIN_B }, etagB, { weekStartsOn: 0 });
    expect(store.rows.get(TENANT_A)?.settings).toEqual({});
    expect(store.audits.map((a) => a.tenantId)).toEqual([TENANT_B]);
  });
});
