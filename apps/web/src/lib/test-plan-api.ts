import {
  gate1SubmitResponseSchema,
  planDiffSchema,
  planValidationResultSchema,
  testCaseViewSchema,
  testPlanPageSchema,
  testPlanViewSchema,
  TEST_PLAN_PAGE_MAX,
  type PlanDiff,
  type PlanValidationResult,
  type TestCaseCreateBody,
  type TestCasePatchBody,
  type TestCaseView,
  type Gate1SubmitResponse,
  type TestPlanPage,
  type TestPlanView,
} from '@blackwing/contracts';

import { type ApiClient, createApiClient } from './api-client';

/**
 * Query keys of the plan editor. A case write invalidates the version it changed and that version's validation,
 * so the banner and the budget totals are never answered from a plan that has since moved.
 */
export const testPlanKeys = {
  versions: (runId: string) => ['testPlans', 'versions', runId] as const,
  version: (runId: string, version: number) => ['testPlans', 'version', runId, version] as const,
  diff: (runId: string, version: number, against: number) =>
    ['testPlans', 'diff', runId, version, against] as const,
  validation: (planId: string) => ['testPlans', 'validation', planId] as const,
};

/**
 * Typed client for the PLAN-005/006/007 endpoints, through the BFF `/v1` (session cookie, no token in JS).
 * Every write carries the `If-Match` it validates against: the plan ETag for cases added to a version, the
 * case ETag for an edit or removal. The server answers 412 `ETAG_MISMATCH` when another write got there first.
 */
export interface TestPlanApi {
  listVersions: (runId: string, signal?: AbortSignal) => Promise<TestPlanPage>;
  getVersion: (runId: string, version: number, signal?: AbortSignal) => Promise<TestPlanView>;
  /** Starts the next draft version, copied from the newest one. */
  createVersion: (runId: string) => Promise<TestPlanView>;
  diff: (
    runId: string,
    version: number,
    against: number,
    signal?: AbortSignal,
  ) => Promise<PlanDiff>;
  validate: (planId: string, signal?: AbortSignal) => Promise<PlanValidationResult>;
  addCase: (planId: string, body: TestCaseCreateBody, planEtag: string) => Promise<TestCaseView>;
  updateCase: (caseId: string, body: TestCasePatchBody, caseEtag: string) => Promise<TestCaseView>;
  removeCase: (caseId: string, caseEtag: string) => Promise<void>;
  /** Validates the current plan version and moves the run to `awaiting_gate1` (PLAN-008, #398). */
  submitForGate1: (runId: string) => Promise<Gate1SubmitResponse>;
}

export function createTestPlanApi(client: ApiClient = createApiClient()): TestPlanApi {
  const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}/test-plans`;
  return {
    listVersions: (runId, signal) =>
      client.get(runPath(runId), testPlanPageSchema, {
        query: { limit: TEST_PLAN_PAGE_MAX },
        signal,
      }),
    getVersion: (runId, version, signal) =>
      client.get(`${runPath(runId)}/${version}`, testPlanViewSchema, { signal }),
    createVersion: (runId) => client.post(runPath(runId), testPlanViewSchema),
    diff: (runId, version, against, signal) =>
      client.get(`${runPath(runId)}/${version}/diff`, planDiffSchema, {
        query: { against },
        signal,
      }),
    validate: (planId, signal) =>
      client.get(
        `/test-plans/${encodeURIComponent(planId)}/validation`,
        planValidationResultSchema,
        {
          signal,
        },
      ),
    addCase: (planId, body, planEtag) =>
      client.post(`/test-plans/${encodeURIComponent(planId)}/cases`, testCaseViewSchema, body, {
        ifMatch: planEtag,
      }),
    updateCase: (caseId, body, caseEtag) =>
      client.patch(`/test-cases/${encodeURIComponent(caseId)}`, testCaseViewSchema, body, {
        ifMatch: caseEtag,
      }),
    removeCase: (caseId, caseEtag) =>
      client.delete(`/test-cases/${encodeURIComponent(caseId)}`, { ifMatch: caseEtag }),
    submitForGate1: (runId) =>
      client.post(`/runs/${encodeURIComponent(runId)}/gate1/submit`, gate1SubmitResponseSchema),
  };
}
