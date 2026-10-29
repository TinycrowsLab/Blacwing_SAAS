import {
  assessmentRequestPublicIdSchema,
  type createAssessmentRequestSchema,
  assessmentRequestResponseSchema,
  assetListResponseSchema,
  type AssessmentRequestResponse,
  type AssetListResponse,
  type PatchAssessmentRequest,
} from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client';

import type { z } from 'zod';

/** Query keys of the scoping wizard. A write invalidates the draft it changed; the asset list is read-only here. */
export const assessmentWizardKeys = {
  assets: ['assessment-wizard', 'assets'] as const,
  draft: (id: string) => ['assessment-wizard', 'draft', id] as const,
};

/**
 * `If-Match` of a draft at `stateVersion`. The server's ETag is `"v<stateVersion>"` (SCOPE-005), so sending it
 * explicitly means a write is refused (412) when another tab changed the draft since this one read it.
 */
export function ifMatchFor(stateVersion: number): string {
  return `"v${String(stateVersion)}"`;
}

export interface AssessmentRequestApi {
  /** Assets of the caller's tenant (`GET /v1/assets`). Unverified ones come back too and are shown disabled. */
  assets: (signal?: AbortSignal) => Promise<AssetListResponse>;
  get: (id: string, signal?: AbortSignal) => Promise<AssessmentRequestResponse>;
  /** Creates the draft. The create body needs an objective, so the wizard calls this on the last step. */
  create: (
    body: z.input<typeof createAssessmentRequestSchema>,
  ) => Promise<AssessmentRequestResponse>;
  /** Updates the draft; `stateVersion` is the version the caller last read (If-Match). */
  patch: (
    id: string,
    stateVersion: number,
    body: PatchAssessmentRequest,
  ) => Promise<AssessmentRequestResponse>;
}

/** Typed client of the scoping endpoints, through the BFF `/v1` (session cookie, no token in JS). */
export function createAssessmentRequestApi(
  client: ApiClient = createApiClient(),
): AssessmentRequestApi {
  return {
    assets: (signal) => client.get('/assets', assetListResponseSchema, { signal }),
    get: (id, signal) =>
      client.get(
        `/assessment-requests/${encodeURIComponent(assessmentRequestPublicIdSchema.parse(id))}`,
        assessmentRequestResponseSchema,
        { signal },
      ),
    create: (body) => client.post('/assessment-requests', assessmentRequestResponseSchema, body),
    patch: (id, stateVersion, body) =>
      client.patch(
        `/assessment-requests/${encodeURIComponent(assessmentRequestPublicIdSchema.parse(id))}`,
        assessmentRequestResponseSchema,
        body,
        { ifMatch: ifMatchFor(stateVersion) },
      ),
  };
}
