// Boundary schemas: every API answer is parsed with Zod before the pages use it (CLAUDE.md).
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
export type Asset = z.infer<typeof assetSchema>;

/** The newest audit ledger event of a decision: its id and chain hash. */
export const auditRefSchema = z
  .object({ eventId: z.string(), hash: z.string() })
  .nullable()
  .default(null);

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
  viewerIsAdmin: z.boolean().default(false),
  selfApproved: z.boolean().default(false),
  testAccounts: z.array(z.object({ role: z.string(), headerName: z.string() })).default([]),
  /** Gate 3 mode: `hold` waits for a human release, `auto` releases what the validator proves. */
  releaseProven: z.enum(['hold', 'auto']).default('auto'),
  audit: auditRefSchema,
});
export type AssessmentRequest = z.infer<typeof requestSchema>;

const runEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  stage: z.string(),
  message: z.string().default(''),
  data: z.record(z.string(), z.unknown()).default({}),
  at: iso,
});
export type RunEvent = z.infer<typeof runEventSchema>;

const pinsSchema = z
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
      .object({
        id: z.string(),
        objective: z.string().default(''),
        intrusiveness: z.string(),
        testAccounts: z.array(z.object({ role: z.string(), headerName: z.string() })).optional(),
      })
      .loose()
      .optional(),
    authorisation: z
      .object({ saId: z.string(), signedBy: z.string().nullable(), keyId: z.string() })
      .optional(),
  })
  .loose();

const gate2Schema = z.object({
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
  secondsLeft: z.number().default(0),
  decisionReason: z.string().nullable().default(null),
  run: z.object({ id: z.string(), assetName: z.string().optional() }).optional(),
});
export type Gate2 = z.infer<typeof gate2Schema>;

export const findingSummarySchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  assetName: z.string().nullable().default(null),
  title: z.string(),
  status: z.string().default('confirmed'),
  severity: severitySchema.default('info'),
  agent: z.string().nullable().default(null),
  cwe: z.string().nullable().default(null),
  owasp: z.string().nullable().default(null),
  createdAt: iso.optional(),
});

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
export type Run = z.infer<typeof runSchema>;

/** Gate 2 as the decision page needs it: the DTO plus the audit event of the decision. */
export const gate2DetailSchema = gate2Schema.extend({ audit: auditRefSchema });

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
      reason: z.string().optional(),
      /** Claude's fix suggestion (optional, not verified): the "How to fix it" block is hidden without it. */
      remediation: z.string().optional(),
    })
    .default({ probe: {}, control: {}, replays: [] }),
  testCaseId: z.string().nullable().default(null),
  triage: z
    .object({ at: iso, by: z.string().nullable(), reason: z.string().nullable() })
    .nullable()
    .default(null),
  delivery: z
    .object({ status: z.enum(['delivered', 'failed']), detail: z.string(), at: iso })
    .nullable()
    .default(null),
  audit: auditRefSchema,
  reproCurl: z.string().default(''),
  agent: z.string().nullable().default(null),
});

const runSummarySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  state: z.string(),
  paused: z.boolean().default(false),
  createdAt: iso,
  startedAt: nullableIso,
  finishedAt: nullableIso,
  assetName: z.string().optional(),
  requestsUsed: z.number().default(0),
  costUsd: z.number().default(0),
});

export const dashboardSchema = z.object({
  /** `name` is null until the first administrator names the workspace on /welcome. */
  tenant: z.object({ id: z.string(), name: z.string().nullable().default(null) }).optional(),
  actor: z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) }),
  counts: z.object({
    assets: z.number(),
    requestsPendingGate1: z.number().default(0),
    runsRunning: z.number().default(0),
    confirmedFindings: z.number(),
    gate2Pending: z.number().default(0),
  }),
  assets: z.array(assetSchema).default([]),
  requests: z.array(requestSchema).default([]),
  runs: z.array(runSummarySchema).default([]),
  findings: z.array(findingSummarySchema).default([]),
  pendingGate2: z.array(gate2Schema).default([]),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

const rangeSchema = z.object({ min: z.number(), max: z.number() });

/** GET /workspace: the name (null until named) and the settings the console needs. */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  settings: z.object({
    gate2TimeoutS: z.number(),
    selfApprove: z.boolean(),
    limits: z.object({ requests: rangeSchema, minutes: rangeSchema, costUsd: rangeSchema }),
    presets: z.array(
      z.object({ key: z.string(), label: z.string(), minutes: z.number(), requests: z.number(), costUsd: z.number() }),
    ),
    webhook: z.object({ configured: z.boolean(), host: z.string().nullable() }),
  }),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** Run states that can still be paused or stopped. */
export const LIVE_RUN_STATES: readonly string[] = ['queued', 'running', 'paused'];
const EARLIER_RUNS = 8;

/** The sidebar's slice of the dashboard (seeded by the console layout, refreshed through /api/sidebar). */
export const sidebarSchema = z.object({
  workspaceName: z.string().nullable(),
  gate2: z.array(
    z.object({ id: z.string(), runId: z.string(), method: z.string(), url: z.string(), deadlineAt: iso, createdAt: iso.optional() }),
  ),
  plans: z.array(z.object({ id: z.string(), assetName: z.string(), createdAt: iso })),
  releases: z.array(z.object({ id: z.string(), title: z.string(), assetName: z.string().nullable() })),
  live: z.array(runSummarySchema),
  earlier: z.array(runSummarySchema),
});
export type SidebarData = z.infer<typeof sidebarSchema>;

export function toSidebar(d: Dashboard): SidebarData {
  return {
    workspaceName: d.tenant?.name ?? null,
    gate2: d.pendingGate2.map((g) => ({
      id: g.id,
      runId: g.runId,
      method: g.method,
      url: g.url,
      deadlineAt: g.deadlineAt,
      ...(g.createdAt === undefined ? {} : { createdAt: g.createdAt }),
    })),
    plans: d.requests
      .filter((r) => r.status === 'pending_gate1')
      .map((r) => ({ id: r.id, assetName: r.assetName ?? '', createdAt: r.createdAt })),
    releases: d.findings
      .filter((f) => f.status === 'confirmed')
      .map((f) => ({ id: f.id, title: f.title, assetName: f.assetName })),
    live: d.runs.filter((r) => LIVE_RUN_STATES.includes(r.state)),
    earlier: d.runs.filter((r) => !LIVE_RUN_STATES.includes(r.state)).slice(0, EARLIER_RUNS),
  };
}
