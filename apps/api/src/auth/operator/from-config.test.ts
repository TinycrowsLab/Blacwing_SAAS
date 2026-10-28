import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

import { deriveKey, seal } from '@blackwing/crypto';

import { operatorAuthOptionsFromConfig } from './from-config.js';
import { OPERATOR_SESSION_LAYOUT } from './operator-session.js';
import {
  OPERATOR_ISSUER,
  operatorSessionRecord,
  sealedOperatorCookie,
} from './operator.test-helpers.js';
import { loadApiConfig } from '../../config.js';
import { NOW_MS } from '../fixtures.test-helpers.js';

import type { AuthOptions } from '../module.js';
import type { Logger } from '@blackwing/logger';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;
const OPERATOR_SECRET = 'o'.repeat(32);
const TENANT_SECRET = 't'.repeat(32);

/** The tenant guard's options as the API builds them; the operator factory only reads its probes and metrics. */
function tenant(): AuthOptions {
  return { metrics: { validated: vi.fn(), jwksFetch: vi.fn() }, logger };
}

function options(
  env: Record<string, string>,
  valkey?: { get: (key: string) => Promise<string | null> },
) {
  return operatorAuthOptionsFromConfig({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000', ...env }),
    logger,
    registry: new Registry(),
    tenant: tenant(),
    ...(valkey === undefined ? {} : { sessionValkey: valkey }),
    now: () => NOW_MS,
  });
}

describe('operatorAuthOptionsFromConfig (#838)', () => {
  it('refuses every operator credential when nothing is configured (fail closed)', () => {
    const built = options({});
    expect(built.operatorJwt).toBeUndefined();
    expect(built.operatorSession).toBeUndefined();
  });

  it('enables operator JWTs only when the operator realm issuer is configured', () => {
    const built = options({ OPERATOR_KEYCLOAK_ISSUER_URL: OPERATOR_ISSUER });
    expect(built.operatorJwt).toBeDefined();
    expect(built.operatorSession).toBeUndefined();
  });

  it('enables operator sessions only with the operator secret and a Valkey', () => {
    expect(
      options({ BW_OPERATOR_SESSION_SECRET: OPERATOR_SECRET }).operatorSession,
    ).toBeUndefined();
    const built = options(
      { BW_OPERATOR_SESSION_SECRET: OPERATOR_SECRET },
      { get: () => Promise.resolve(null) },
    );
    expect(built.operatorSession).toBeDefined();
  });

  it('uses the operator key, not the tenant key: a tenant-sealed operator session is refused', async () => {
    const sid = 'sid_cross';
    const stored = seal(
      deriveKey(OPERATOR_SECRET),
      `${OPERATOR_SESSION_LAYOUT.recordPurposePrefix}${sid}`,
      operatorSessionRecord(),
      600_000,
      NOW_MS,
    );
    const valkey = {
      get: (key: string) =>
        Promise.resolve(key === OPERATOR_SESSION_LAYOUT.recordKeyPrefix + sid ? stored : null),
    };
    const built = options(
      { BW_OPERATOR_SESSION_SECRET: OPERATOR_SECRET, BW_WEB_SESSION_SECRET: TENANT_SECRET },
      valkey,
    );
    const tenantSealed = sealedOperatorCookie(deriveKey(TENANT_SECRET), sid);
    await expect(built.operatorSession?.validate(tenantSealed)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    });
    await expect(
      built.operatorSession?.validate(sealedOperatorCookie(deriveKey(OPERATOR_SECRET), sid)),
    ).resolves.toMatchObject({
      authMethod: 'operator_session',
    });
  });

  it('carries the tenant probes through, so a tenant credential at an operator route can be classified', () => {
    const t = tenant();
    const built = operatorAuthOptionsFromConfig({
      config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
      logger,
      registry: new Registry(),
      tenant: t,
      now: () => NOW_MS,
    });
    expect(built.tenant).toEqual({ bearer: undefined, keycloak: undefined, session: undefined });
  });
});
