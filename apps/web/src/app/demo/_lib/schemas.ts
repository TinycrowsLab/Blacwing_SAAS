// DEMO-STORY boundary schemas: every demo API answer is parsed with Zod before the pages use it (CLAUDE.md).
import { z } from 'zod';

const iso = z.string();

export const assetSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  ownership: z.object({ status: z.string(), method: z.string().nullable(), basis: z.string() }),
});
export type DemoAsset = z.infer<typeof assetSchema>;

export const requestSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  testCaseId: z.string(),
  scope: z.record(z.string(), z.unknown()),
  intrusiveness: z.string(),
  budget: z.object({ requests: z.number(), seconds: z.number() }),
  status: z.string(),
  requester: z.object({ id: z.string(), name: z.string().nullable() }),
  approver: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  decisionReason: z.string().nullable(),
  decidedAt: iso.nullable(),
  createdAt: iso,
  runId: z.string().nullable(),
  viewerIsRequester: z.boolean().default(false),
});
export type DemoRequest = z.infer<typeof requestSchema>;

export const runEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  stage: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  at: iso,
});
export type DemoRunEvent = z.infer<typeof runEventSchema>;

export const runSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  state: z.string(),
  requestsUsed: z.number(),
  budgetRequests: z.number(),
  pins: z.record(z.string(), z.unknown()),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  lastSeq: z.number(),
  events: z.array(runEventSchema),
  findingId: z.string().nullable(),
});
export type DemoRun = z.infer<typeof runSchema>;

export const findingSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  status: z.string(),
  cwe: z.string(),
  owasp: z.string(),
  severity: z.object({ cvssV4Vector: z.string(), cvssV4Score: z.number() }),
  location: z.record(z.string(), z.unknown()),
  oracle: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()),
  replay: z.record(z.string(), z.unknown()),
  reproCurl: z.string(),
  createdAt: iso,
});
export type DemoFinding = z.infer<typeof findingSchema>;

export const dashboardSchema = z.object({
  actor: z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) }),
  counts: z.object({
    assets: z.number(),
    requestsPendingGate1: z.number(),
    runs: z.number(),
    confirmedFindings: z.number(),
  }),
  assets: z.array(assetSchema),
  requests: z.array(requestSchema),
  runs: z.array(z.object({ id: z.string(), requestId: z.string(), state: z.string(), createdAt: iso })),
  findings: z.array(z.object({ id: z.string(), title: z.string(), createdAt: iso })),
});
export type DemoDashboard = z.infer<typeof dashboardSchema>;
