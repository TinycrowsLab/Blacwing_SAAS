import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveKey, seal } from '@blackwing/crypto';
import { isAppError } from '@blackwing/errors';

import {
  NOW_MS,
  sealedSessionCookie,
  sealedSessionRecord,
  sessionRecord,
} from '../fixtures.test-helpers.js';
import { createSessionCookieValidator, SESSION_RECORD_KEY_PREFIX } from '../session-cookie.js';
import { createOperatorSessionValidator, OPERATOR_SESSION_LAYOUT } from './operator-session.js';
import {
  operatorSessionRecord,
  sealedOperatorCookie,
  sealedOperatorRecord,
} from './operator.test-helpers.js';

const OPERATOR_KEY = deriveKey('o'.repeat(32));
const TENANT_KEY = deriveKey('t'.repeat(32));
const SID = 'sid_operator_01';
const PREFIX = OPERATOR_SESSION_LAYOUT.recordKeyPrefix;

/** A Valkey stand-in: `get` answers from a map, or throws when the store is down. */
function valkeyWith(entries: Record<string, string>, down = false) {
  return {
    get: (key: string): Promise<string | null> =>
      down
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(entries[key] ?? null),
  };
}

const now = () => NOW_MS;

function validatorWith(entries: Record<string, string>, down = false) {
  return createOperatorSessionValidator({
    keys: [OPERATOR_KEY],
    valkey: valkeyWith(entries, down),
    now,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
  throw new Error('the operator session was accepted');
}

describe('operator BFF session validation (#838)', () => {
  it('resolves a live operator session to an operator principal with no tenant', async () => {
    const validator = validatorWith({
      [PREFIX + SID]: sealedOperatorRecord(OPERATOR_KEY, SID, operatorSessionRecord()),
    });
    const principal = await validator.validate(sealedOperatorCookie(OPERATOR_KEY, SID));
    expect(principal).toEqual({
      operatorId: 'op_0001',
      kind: 'operator',
      roles: ['platform_operator'],
      acr: 'operator_strong',
      authMethod: 'operator_session',
    });
    expect('tenantId' in principal).toBe(false);
  });

  it('re-checks the second factor on every request: a stored weaker acr is blocked', async () => {
    const validator = validatorWith({
      [PREFIX + SID]: sealedOperatorRecord(
        OPERATOR_KEY,
        SID,
        operatorSessionRecord({ acr: 'password' }),
      ),
    });
    expect(await codeOf(validator.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'OPERATOR_MFA_REQUIRED',
    );
  });

  it('refuses a record missing its acr or its roles', async () => {
    const noAcr = validatorWith({
      [PREFIX + SID]: sealedOperatorRecord(
        OPERATOR_KEY,
        SID,
        operatorSessionRecord({ acr: undefined }),
      ),
    });
    expect(await codeOf(noAcr.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    const noRoles = validatorWith({
      [PREFIX + SID]: sealedOperatorRecord(
        OPERATOR_KEY,
        SID,
        operatorSessionRecord({ roles: 'platform_operator' }),
      ),
    });
    expect(await codeOf(noRoles.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('reports a session that no longer exists as expired (ended or offboarded: sign in again)', async () => {
    expect(await codeOf(validatorWith({}).validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_EXPIRED',
    );
  });

  it('reports an unreachable session store as an outage, never as a logged-out or served session', async () => {
    expect(
      await codeOf(validatorWith({}, true).validate(sealedOperatorCookie(OPERATOR_KEY, SID))),
    ).toBe('EXTERNAL_BACKEND_UNAVAILABLE');
  });

  it('never opens a tenant session cookie (a different key and purpose)', async () => {
    const tenantCookie = sealedSessionCookie(TENANT_KEY, SID);
    const validator = validatorWith({
      [PREFIX + SID]: sealedOperatorRecord(OPERATOR_KEY, SID, operatorSessionRecord()),
    });
    expect(await codeOf(validator.validate(tenantCookie))).toBe('AUTH_INVALID_TOKEN');
  });

  it('never opens a tenant record: the tenant keyspace is not the operator keyspace', async () => {
    // A live tenant record under the tenant prefix does not make an operator session exist.
    const validator = validatorWith({
      [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(OPERATOR_KEY, SID, sessionRecord()),
    });
    expect(await codeOf(validator.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_EXPIRED',
    );
  });

  it('an operator cookie is not accepted by the tenant session validator (no swapped cookies)', async () => {
    const tenant = createSessionCookieValidator({
      keys: [TENANT_KEY],
      valkey: valkeyWith({
        [SESSION_RECORD_KEY_PREFIX + SID]: sealedSessionRecord(TENANT_KEY, SID, sessionRecord()),
      }),
      now,
    });
    expect(await codeOf(tenant.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses a record moved under another session id (the purpose is bound to the id)', async () => {
    const moved = sealedOperatorRecord(OPERATOR_KEY, 'sid_someone_else', operatorSessionRecord());
    const validator = validatorWith({ [PREFIX + SID]: moved });
    expect(await codeOf(validator.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses a record sealed with a foreign key', async () => {
    const forged = sealedOperatorRecord(randomBytes(32), SID, operatorSessionRecord());
    const validator = validatorWith({ [PREFIX + SID]: forged });
    expect(await codeOf(validator.validate(sealedOperatorCookie(OPERATOR_KEY, SID)))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('accepts the previous operator key during a rotation, never a tenant key', async () => {
    const previous = deriveKey('p'.repeat(32));
    const validator = createOperatorSessionValidator({
      keys: [OPERATOR_KEY, previous],
      valkey: valkeyWith({
        [PREFIX + SID]: sealedOperatorRecord(previous, SID, operatorSessionRecord()),
      }),
      now,
    });
    const cookie = seal(
      previous,
      OPERATOR_SESSION_LAYOUT.cookiePurpose,
      { sid: SID },
      600_000,
      NOW_MS,
    );
    await expect(validator.validate(cookie)).resolves.toMatchObject({
      authMethod: 'operator_session',
    });
  });
});
