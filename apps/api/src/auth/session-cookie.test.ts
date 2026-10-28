import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveKey, seal } from '@blackwing/crypto';
import { isAppError } from '@blackwing/errors';

import {
  NOW_MS,
  sealedSessionCookie,
  sealedSessionRecord,
  sessionRecord,
  TENANT,
  OTHER_TENANT,
} from './fixtures.test-helpers.js';
import {
  createSessionCookieValidator,
  SESSION_RECORD_KEY_PREFIX,
  type SessionValkey,
} from './session-cookie.js';

const SID = 'sid_01HZ';
const KEY = deriveKey('s'.repeat(32));

/** An in-memory Valkey: the `get` the validator needs, over a map the test fills. */
function fakeValkey(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const valkey: SessionValkey = {
    get: (key) => Promise.resolve(map.get(key) ?? null),
  };
  return { valkey, map };
}

function validatorWith(valkey: SessionValkey, keys: [Buffer, ...Buffer[]] = [KEY]) {
  return createSessionCookieValidator({ keys, valkey, now: () => NOW_MS });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
  throw new Error('the session was accepted');
}

describe('BFF session cookie validation', () => {
  it('resolves a live session to a principal from the stored record', async () => {
    const { valkey } = fakeValkey({
      [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(KEY, SID, sessionRecord()),
    });
    await expect(validatorWith(valkey).validate(sealedSessionCookie(KEY, SID))).resolves.toEqual({
      subjectId: 'usr_01',
      kind: 'user',
      tenantId: TENANT,
      roles: ['tenant_admin'],
      scopes: [],
      authMethod: 'bff_session',
    });
  });

  it('opens a cookie sealed with the previous key during a rotation, never seals with it', async () => {
    const previous = randomBytes(32);
    const { valkey } = fakeValkey({
      [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(KEY, SID, sessionRecord()),
    });
    const cookie = seal(previous, 'session-cookie', { sid: SID }, 600_000, NOW_MS);
    await expect(validatorWith(valkey, [KEY, previous]).validate(cookie)).resolves.toMatchObject({
      authMethod: 'bff_session',
    });
  });

  it('refuses a cookie forged with another key', async () => {
    const { valkey } = fakeValkey();
    const forged = sealedSessionCookie(randomBytes(32), SID);
    expect(await codeOf(validatorWith(valkey).validate(forged))).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses garbage and a cookie sealed for another purpose', async () => {
    const { valkey } = fakeValkey();
    const validator = validatorWith(valkey);
    expect(await codeOf(validator.validate('not-a-cookie'))).toBe('AUTH_INVALID_TOKEN');
    const wrongPurpose = seal(KEY, 'login-cookie', { sid: SID }, 600_000, NOW_MS);
    expect(await codeOf(validator.validate(wrongPurpose))).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an expired cookie', async () => {
    const { valkey } = fakeValkey();
    const expired = sealedSessionCookie(KEY, SID, 1000, NOW_MS - 5000);
    expect(await codeOf(validatorWith(valkey).validate(expired))).toBe('AUTH_INVALID_TOKEN');
  });

  it('reports a session that no longer exists as expired (the user signs in again)', async () => {
    const { valkey } = fakeValkey();
    expect(await codeOf(validatorWith(valkey).validate(sealedSessionCookie(KEY, SID)))).toBe(
      'AUTH_EXPIRED',
    );
  });

  it('refuses a record moved under another session id (purpose is bound to the id)', async () => {
    const moved = sealedSessionRecord(KEY, 'sid_someone_else', sessionRecord());
    const { valkey } = fakeValkey({ [SESSION_RECORD_KEY_PREFIX + SID]: moved });
    expect(await codeOf(validatorWith(valkey).validate(sealedSessionCookie(KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses a record sealed with a key that is not configured', async () => {
    const forged = sealedSessionRecord(randomBytes(32), SID, sessionRecord());
    const { valkey } = fakeValkey({ [SESSION_RECORD_KEY_PREFIX + SID]: forged });
    expect(await codeOf(validatorWith(valkey).validate(sealedSessionCookie(KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses a record without roles or with a tenant that is not a UUID', async () => {
    const noRoles = sealedSessionRecord(KEY, SID, { ...sessionRecord(), roles: undefined });
    const badTenant = sealedSessionRecord(KEY, SID, sessionRecord({ tenantId: 'acme' }));
    const cookie = sealedSessionCookie(KEY, SID);
    expect(
      await codeOf(
        validatorWith(fakeValkey({ [SESSION_RECORD_KEY_PREFIX + SID]: noRoles }).valkey).validate(
          cookie,
        ),
      ),
    ).toBe('AUTH_INVALID_TOKEN');
    expect(
      await codeOf(
        validatorWith(fakeValkey({ [SESSION_RECORD_KEY_PREFIX + SID]: badTenant }).valkey).validate(
          cookie,
        ),
      ),
    ).toBe('AUTH_INVALID_TOKEN');
  });

  it('reports a Valkey outage as a 503 backend error, never as a pass', async () => {
    const down: SessionValkey = {
      get: () => Promise.reject(new Error('connection refused')),
    };
    expect(await codeOf(validatorWith(down).validate(sealedSessionCookie(KEY, SID)))).toBe(
      'EXTERNAL_BACKEND_UNAVAILABLE',
    );
  });

  it('keeps tenants apart: the principal carries the record tenant, not another', async () => {
    const { valkey } = fakeValkey({
      [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(
        KEY,
        SID,
        sessionRecord({ tenantId: OTHER_TENANT }),
      ),
    });
    await expect(
      validatorWith(valkey).validate(sealedSessionCookie(KEY, SID)),
    ).resolves.toMatchObject({
      tenantId: OTHER_TENANT,
    });
  });
});
