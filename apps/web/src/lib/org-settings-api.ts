import { type OrgProfile, orgProfileSchema, type OrgSettings } from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client';

/** Path of the organisation profile on the BFF `/v1` (the tenant comes from the session, never the path). */
export const ORG_PROFILE_PATH = '/tenants/current';

/** Query key of the organisation profile. */
export const orgProfileKey = ['tenants', 'current'] as const;

export interface OrgSettingsApi {
  get: (signal?: AbortSignal) => Promise<OrgProfile>;
  /** Sends the `If-Match` of the last read; a stale one is refused as `ETAG_MISMATCH`. */
  update: (body: Partial<OrgSettings>) => Promise<OrgProfile>;
}

/** Typed client for the organisation profile (ADMIN-001). Reads and writes go through the BFF session cookie. */
export function createOrgSettingsApi(client: ApiClient = createApiClient()): OrgSettingsApi {
  return {
    get: (signal) => client.get(ORG_PROFILE_PATH, orgProfileSchema, { signal }),
    update: (body) => client.patch(ORG_PROFILE_PATH, orgProfileSchema, body),
  };
}
