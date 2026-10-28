import { randomBytes } from 'node:crypto';

import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { deriveKey, seal } from '@blackwing/crypto';
import { createLogger } from '@blackwing/logger';

import { loadApiConfig } from '../config.js';
import {
  sealedSessionCookie,
  sealedSessionRecord,
  sessionRecord,
  NOW_MS,
} from './fixtures.test-helpers.js';
import { authOptionsFromConfig } from './from-config.js';
import { SESSION_RECORD_KEY_PREFIX } from './session-cookie.js';

const minimal = { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' };
const SECRET = 'a'.repeat(32);
const PREVIOUS = 'b'.repeat(32);
const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });

function options(
  source: Record<string, string>,
  sessionValkey?: { get(key: string): Promise<string | null> },
) {
  return authOptionsFromConfig({
    config: loadApiConfig({ ...minimal, ...source }),
    logger,
    registry: new Registry(),
    ...(sessionValkey === undefined ? {} : { sessionValkey }),
    now: () => NOW_MS,
  });
}

describe('authOptionsFromConfig', () => {
  it('builds no path when nothing is configured, so every credential is refused', () => {
    const built = options({});
    expect(built.keycloak).toBeUndefined();
    expect(built.session).toBeUndefined();
    expect(built.bearer).toBeUndefined();
  });

  it('builds the Keycloak path when an issuer is configured', () => {
    const built = options({ KEYCLOAK_ISSUER_URL: 'https://idp.example.test/realms/blackwing' });
    expect(built.keycloak).toBeDefined();
  });

  it('keeps the BFF session path off without a Valkey read, even with a secret (fail closed)', () => {
    expect(options({ BW_WEB_SESSION_SECRET: SECRET }).session).toBeUndefined();
  });

  it('opens session cookies with the current and the previous secret during a rotation', async () => {
    const sid = 'sid_rotation';
    const previousSealed = seal(deriveKey(PREVIOUS), 'session-cookie', { sid }, 600_000, NOW_MS);
    const record = sealedSessionRecord(deriveKey(PREVIOUS), sid, sessionRecord());
    const valkey = {
      get: (key: string) =>
        Promise.resolve(key === SESSION_RECORD_KEY_PREFIX + sid ? record : null),
    };
    const built = options(
      { BW_WEB_SESSION_SECRET: SECRET, BW_WEB_SESSION_SECRET_PREVIOUS: PREVIOUS },
      valkey,
    );
    expect(built.session).toBeDefined();
    await expect(built.session?.validate(previousSealed)).resolves.toMatchObject({
      authMethod: 'bff_session',
    });
    // A cookie sealed with an unrelated key is still refused.
    await expect(
      built.session?.validate(sealedSessionCookie(randomBytes(32), sid)),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
  });
});
