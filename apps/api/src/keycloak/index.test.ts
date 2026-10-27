import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createOrganizationsService, OrganizationsService } from './index.js';

import type { OrganizationAuditSink } from './organizations.service.js';
import type { OpenBaoClient, OpenBaoResponse } from '@blackwing/secrets';

const complete = {
  KEYCLOAK_ADMIN_URL: 'https://id.example.test',
  KEYCLOAK_ADMIN_REALM: 'blackwing',
  KEYCLOAK_ORG_ADMIN_CLIENT_ID: 'bw-org-admin',
  KEYCLOAK_ORG_ADMIN_SECRET_PATH: 'secret/data/platform/keycloak/org-admin',
};

const audit: OrganizationAuditSink = { record: () => Promise.resolve() };
const logger = createLogger('keycloak-test', { destination: { write: () => true } });

/** Records every OpenBao read so a test can prove the secret is not fetched at construction time. */
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

describe('createOrganizationsService', () => {
  it('builds the service from a complete environment without reading the secret at boot', () => {
    const openBao = openBaoSpy();
    const service = createOrganizationsService({
      env: complete,
      openBao: openBao.client,
      audit,
      logger,
    });
    expect(service).toBeInstanceOf(OrganizationsService);
    expect(openBao.reads).toEqual([]);
  });

  it('refuses to build when any admin key is missing (fails closed, no partial credential)', () => {
    const openBao = openBaoSpy();
    for (const key of Object.keys(complete) as (keyof typeof complete)[]) {
      const partial = { ...complete, [key]: undefined };
      expect(() =>
        createOrganizationsService({ env: partial, openBao: openBao.client, audit, logger }),
      ).toThrow(AppError);
    }
    expect(openBao.reads).toEqual([]);
  });
});
