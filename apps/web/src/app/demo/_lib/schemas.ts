// Boundary schemas: every demo API answer is parsed with Zod before the pages use it (CLAUDE.md).
// DTOs follow docs/poc/AI_HUNT_POC.md section 3. Optional fields tolerate an API that has not filled them yet.
import { z } from 'zod';

const iso = z.string();
const nullableIso = iso.nullable().default(null);
const strings = z.array(z.string()).default([]);

/** The API names severity either as a word or as a CVSS score object; the pages use the word. */
const CVSS_CRITICAL = 9;
const CVSS_HIGH = 7;
const CVSS_MEDIUM = 4;

const severitySchema = z
  .union([z.string(), z.object({ cvssV4Score: z.number() })])
  .transform((value) => {
    if (typeof value === 'string') return value.toLowerCase();
    if (value.cvssV4Score >= CVSS_CRITICAL) return 'critical';
    if (value.cvssV4Score >= CVSS_HIGH) return 'high';
    if (value.cvssV4Score >= CVSS_MEDIUM) return 'medium';
    return value.cvssV4Score > 0 ? 'low' : 'info';
  });

export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  allowedOrigins: strings,
  excludedPaths: strings,
  ownership: z.object({
    status: z.string(),
    method: z.string().nullable().default(null),
    verifiedBy: z.string().nullable().default(null),
    verifiedAt: nullableIso,
  }),
  verification: z
    .object({ token: z.string().nullable(), wellKnownUrl: z.string() })
    .nullable()
    .default(null),
});
export type DemoAsset = z.infer<typeof assetSchema>;

const personSchema = z.object({ id: z.string(), name: z.string().nullable() });

export const requestSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  assetName: z.string().optional(),
  objective: z.string().default(''),
  intrusiveness: z.string(),
  budget: z.object({
    requests: z.number(),
    seconds: z.number(),
    costUsd: z.number().nullable().default(null),
  }),
  excludedPaths: strings,
  status: z.string(),
  requester: personSchema,
  approver: personSchema.nullable().default(null),
  decisionReason: z.string().nullable().default(null),
  decidedAt: nullableIso,
  createdAt: iso,
  runId: z.string().nullable().default(null),
  viewerIsRequester: z.boolean().default(false),
});
export type DemoRequest = z.infer<typeof requestSchema>;

export const runEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  stage: z.string(),
  message: z.string().default(''),
  data: z.record(z.string(), z.unknown()).default({}),
  at: iso,
});
export type DemoRunEvent = z.infer<typeof runEventSchema>;

export const pinsSchema = z
  .object({
    asset: z
      .object({
        id: z.string(),
        name: z.string(),
        baseUrl: z.string(),
        allowedOrigins: strings,
        excludedPaths: strings,
      })
      .optional(),
    request: z
      .object({ id: z.string(), objective: z.string().default(''), intrusiveness: z.string() })
      .loose()
      .optional(),
    authorisation: z
      .object({ saId: z.string(), signedBy: z.string().nullable(), keyId: z.string() })
      .optional(),
  })
  .loose();

export const gate2Schema = z.object({
  id: z.string(),
  runId: z.string(),
  agent: z.string(),
  method: z.string(),
  url: z.string(),
  pathKey: z.string().default(''),
  intrusiveness: z.string().default('state_changing'),
  reason: z.string().default(''),
  whyOutside: z.string().default(''),
  status: z.string(),
  deadlineAt: iso,
  createdAt: iso.optional(),
  decidedBy: z.string().nullable().default(null),
  decidedAt: nullableIso,
  run: z.object({ id: z.string(), assetName: z.string().optional() }).optional(),
});
export type DemoGate2 = z.infer<typeof gate2Schema>;

export const findingSummarySchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  title: z.string(),
  status: z.string().default('confirmed'),
  severity: severitySchema.default('info'),
  agent: z.string().nullable().default(null),
  cwe: z.string().nullable().default(null),
  owasp: z.string().nullable().default(null),
  createdAt: iso.optional(),
});
export type DemoFindingSummary = z.infer<typeof findingSummarySchema>;

export const runSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  state: z.string(),
  paused: z.boolean().default(false),
  costUsd: z.number().default(0),
  requestsUsed: z.number().default(0),
  budget: z.object({
    requests: z.number(),
    seconds: z.number(),
    costUsd: z.number().default(0),
  }),
  createdAt: iso,
  startedAt: nullableIso,
  finishedAt: nullableIso,
  haltMs: z.number().nullable().default(null),
  summary: z.string().nullable().default(null),
  pins: pinsSchema.default({}),
  lastSeq: z.number().default(0),
  events: z.array(runEventSchema).default([]),
  findings: z.array(findingSummarySchema).default([]),
  gate2: z.array(gate2Schema).default([]),
  stats: z
    .object({
      httpSent: z.number().default(0),
      blocked: z.number().default(0),
      gate2Pending: z.number().default(0),
    })
    .default({ httpSent: 0, blocked: 0, gate2Pending: 0 }),
});
export type DemoRun = z.infer<typeof runSchema>;

/** Gate 2 as the decision page needs it: the DTO plus the seconds left when the server answered. */
export const gate2DetailSchema = gate2Schema.extend({ secondsLeft: z.number().default(0) });

const findingEvidenceSchema = z.object({
  request: z
    .object({
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().nullish(),
    })
    .optional(),
  response: z
    .object({
      status: z.number(),
      bodyExcerpt: z.string().optional(),
      bodySha256: z.string().optional(),
    })
    .optional(),
});

export const findingSchema = findingSummarySchema.extend({
  description: z.string().nullable().default(null),
  oracle: z.object({ type: z.string(), value: z.string() }).partial().default({}),
  evidence: z
    .object({
      probe: findingEvidenceSchema.default({}),
      control: findingEvidenceSchema.default({}),
      replays: z
        .array(z.object({ n: z.number(), status: z.number(), matched: z.boolean() }))
        .default([]),
    })
    .default({ probe: {}, control: {}, replays: [] }),
  reproCurl: z.string().default(''),
  agent: z.string().nullable().default(null),
});
export type DemoFinding = z.infer<typeof findingSchema>;

export const dashboardSchema = z.object({
  actor: z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) }),
  counts: z.object({
    assets: z.number(),
    requestsPendingGate1: z.number().default(0),
    runs: z.number(),
    confirmedFindings: z.number(),
  }),
  assets: z.array(assetSchema).default([]),
  requests: z.array(requestSchema).default([]),
  runs: z
    .array(
      z.object({
        id: z.string(),
        requestId: z.string(),
        state: z.string(),
        createdAt: iso,
        assetName: z.string().optional(),
        requestsUsed: z.number().default(0),
        costUsd: z.number().default(0),
      }),
    )
    .default([]),
  findings: z.array(findingSummarySchema).default([]),
  pendingGate2: z.array(gate2Schema).default([]),
});
export type DemoDashboard = z.infer<typeof dashboardSchema>;
