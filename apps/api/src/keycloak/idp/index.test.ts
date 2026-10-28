import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { IdentityProviderService } from './identity-provider.service.js';
import { createIdentityProviderService } from './index.js';

import type { OpenBaoClient, OpenBaoResponse } from '@blackwing/secrets';

const complete = {
  KEYCLOAK_ADMIN_URL: 'https://id.example.test',
  KEYCLOAK_ADMIN_REALM: 'blackwing',
  KEYCLOAK_ORG_ADMIN_CLIENT_ID: 'bw-org-admin',
  KEYCLOAK_ORG_ADMIN_SECRET_PATH: 'secret/data/platform/keycloak/org-admin',
};

const audit = { record: () => Promise.resolve() };
const logger = createLogger('keycloak-idp-test', { destination: { write: () => true } });
const organizationIdFor = () => Promise.resolve(undefined);

/** Records every OpenBao read so a test can prove no secret is fetched at construction time. */
function openBaoSpy(): { client: OpenBaoClient; reads: string[] } {
  const reads: string[] = [];
  const client: OpenBaoClient = {
    request(_method: string, path: string): Promise<OpenBaoResponse> {
      reads.push(path);
      return Promise.resolve({ status: 200, data: { data: { client_secret: 'secret-v1' } } });
    },
  };
  return { client, reads };
}

describe('createIdentityProviderService', () => {
  it('builds the service from a complete environment without reading any secret at boot', () => {
    const openBao = openBaoSpy();
    const service = createIdentityProviderService({
      env: complete,
      openBao: openBao.client,
      audit,
      logger,
      organizationIdFor,
    });
    expect(service).toBeInstanceOf(IdentityProviderService);
    expect(openBao.reads).toEqual([]);
  });

  it('refuses to build when any Keycloak admin key is missing (fails closed, no partial credential)', () => {
    const openBao = openBaoSpy();
    for (const key of Object.keys(complete) as (keyof typeof complete)[]) {
      const partial = { ...complete, [key]: undefined };
      expect(() =>
        createIdentityProviderService({
          env: partial,
          openBao: openBao.client,
          audit,
          logger,
          organizationIdFor,
        }),
      ).toThrow(AppError);
    }
    expect(openBao.reads).toEqual([]);
  });
});
