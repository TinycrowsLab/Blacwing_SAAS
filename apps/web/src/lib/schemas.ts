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
  /** True when the operator listed every origin of this asset as a lab (owner attestation is allowed there). */
  lab: z.boolean().default(false),
  verification: z
    .object({
      token: z.string().nullable(),
      wellKnownUrl: z.string(),
      methods: z.array(z.enum(['http_token', 'owner_attestation'])).default(['http_token', 'owner_attestation']),
    })
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
  /** Plan version: an edit or a decision names the version it saw (a mismatch is 409 plan_changed). */
  version: z.number().int().default(1),
  /** pending_gate1 | approved | rejected | running | completed, or the terminal failed | killed. */
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
  testAccounts: z.array(z.object({ role: z.string(), headerName: z.string(), loginUsername: z.string().optional(), loginUrl: z.string().optional() })).default([]),
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
        testAccounts: z.array(z.object({ role: z.string(), headerName: z.string(), loginUsername: z.string().optional(), loginUrl: z.string().optional() })).optional(),
      })
      .loose()
      .optional(),
    authorisation: z
      .object({ saId: z.string(), signedBy: z.string().nullable(), keyId: z.string().optional() })
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
  /** The request body as asked (scrubbed); null for asks recorded before it was stored. */
  body: z.string().nullable().default(null),
  asRole: z.string().nullable().default(null),
  assetName: z.string().nullable().default(null),
  /** Who asked for the audit this request belongs to. */
  requester: personSchema.nullable().default(null),
  runStartedAt: nullableIso,
  /** deadline | run_ended | killed | worker_restarted when the ask closed without a person deciding. */
  closeReason: z.string().nullable().default(null),
  run: z
    .object({
      id: z.string(),
      assetName: z.string().optional(),
      startedBy: personSchema.nullable().optional(),
      viewerIsRequester: z.boolean().optional(),
    })
    .loose()
    .optional(),
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
  identityKey: z.string().nullable().default(null),
  /** The earliest finding with the same identity in an earlier audit of this workspace. */
  seenBefore: z
    .object({ runId: z.string(), findingId: z.string(), status: z.string(), at: iso })
    .nullable()
    .default(null),
});

/** What the run covered (the run's last coverage.summary event); null for older or still-running runs. */
export const coverageSchema = z.object({
  cases: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        agent: z.string(),
        status: z.enum(['executed', 'skipped', 'blocked', 'model_declined', 'not_run']),
        note: z.string().nullable().default(null),
        requests: z.number().default(0),
        candidates: z.number().default(0),
      }),
    )
    .default([]),
  rolesConfigured: strings,
  rolesUsed: z.record(z.string(), z.number()).default({}),
  requestsSent: z.number().default(0),
  endReason: z.string().nullable().default(null),
});
export type Coverage = z.infer<typeof coverageSchema>;

/** Only while a run is queued: its place in the line and how many run at a time. */
const queueSchema = z.object({ position: z.number(), ahead: z.number(), running: z.number(), concurrency: z.number() });

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
  startedBy: personSchema.nullable().default(null),
  queue: queueSchema.nullable().default(null),
  coverage: coverageSchema.nullable().default(null),
});
export type Run = z.infer<typeof runSchema>;

/** The care levels by the names people chose them by. */
export const CARE_LABEL: Readonly<Record<string, string>> = { passive: "Look, don't touch", active_safe: 'Probe gently' };

/** The authorisation a run was pinned to (run.pins), as the run and the Gate 2 screens show it. */
export interface PinnedAuthorisation {
  readonly saId: string;
  readonly signedBy: string | null;
  /** The care level's label ("Probe gently"); null when the run did not pin it. */
  readonly care: string | null;
  readonly origins: readonly string[];
  readonly excludedPaths: readonly string[];
}

/** Null when the run pinned no authorisation (nothing is shown rather than guessed). */
export function pinnedAuthorisation(pins: Run['pins']): PinnedAuthorisation | null {
  const auth = pins.authorisation;
  if (auth === undefined) return null;
  const care = pins.request?.intrusiveness;
  return {
    saId: auth.saId,
    signedBy: auth.signedBy,
    care: care === undefined || care === '' ? null : (CARE_LABEL[care] ?? care),
    origins: pins.asset?.allowedOrigins ?? [],
    excludedPaths: pins.asset?.excludedPaths ?? [],
  };
}

/** Gate 2 as the decision page needs it: the DTO plus the audit event of the decision. */
export const gate2DetailSchema = gate2Schema.extend({ audit: auditRefSchema });

const findingEvidenceSchema = z.object({
  exchangeId: z.string().optional(),
  request: z
    .object({
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().nullish(),
      asRole: z.string().nullable().optional(),
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
      /** Blackwing AI's fix suggestion (optional, not verified): the "How to fix it" block is hidden without it. */
      remediation: z.string().optional(),
      proof: z
        .object({ kind: z.string(), replays: z.number(), delta: z.string().nullable(), proposedBy: z.string() })
        .partial()
        .optional(),
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
  retests: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(),
        result: z.string().nullable().default(null),
        requestedBy: z.string().nullable().default(null),
        createdAt: iso,
        finishedAt: nullableIso,
        detail: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});

const runSummarySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  state: z.string(),
  paused: z.boolean().default(false),
  createdAt: iso,
  startedAt: nullableIso,
  finishedAt: nullableIso,
  assetId: z.string().optional(),
  assetName: z.string().optional(),
  requestsUsed: z.number().default(0),
  costUsd: z.number().default(0),
  startedBy: personSchema.nullable().default(null),
  queue: queueSchema.nullable().default(null),
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
  /** Exact, uncapped counts of what waits on people (the lists above stay capped). */
  pendingCounts: z
    .object({
      gate1: z.number(),
      gate2: z.number(),
      gate3: z.number(),
      keptBack: z.number().default(0),
      live: z.number(),
    })
    .optional(),
  /** Every live run, uncapped, newest first. */
  liveRuns: z.array(runSummarySchema).optional(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

const rangeSchema = z.object({ min: z.number(), max: z.number() });
/** The workspace's optional emergency contact, shown on an expired emergency link's page. */
export const emergencyContactSchema = z.object({ name: z.string(), phone: z.string() });
export type EmergencyContact = z.infer<typeof emergencyContactSchema>;

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
    huntConcurrency: z.number().optional(),
    emergencyContact: emergencyContactSchema.nullable().default(null),
  }),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** An emergency stop link that still works (Settings). The token is never sent back after it is created. */
export const emergencyLinkSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }),
  createdAt: iso,
  expiresAt: iso,
  lastUsedAt: iso.nullable(),
});
export type EmergencyLink = z.infer<typeof emergencyLinkSchema>;

/** What the no-login emergency page shows: a live link, or the expired page with the workspace's contact. */
export const emergencyViewSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('active'),
    workspace: z.string().nullable(),
    liveRuns: z.number(),
    link: z.object({ label: z.string().nullable(), expiresAt: iso }),
  }),
  z.object({ status: z.literal('expired'), contact: emergencyContactSchema.nullable() }),
]);
export type EmergencyView = z.infer<typeof emergencyViewSchema>;

/** A run an emergency stop reached, and its halt. */
export const emergencyRunSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  assetName: z.string(),
  state: z.string(),
  haltMs: z.number().nullable(),
});
export type EmergencyRun = z.infer<typeof emergencyRunSchema>;

/** Run states that can still be paused or stopped. */
export const LIVE_RUN_STATES: readonly string[] = ['queued', 'running', 'paused'];
const EARLIER_RUNS = 8;

/** The sidebar's slice of the dashboard (seeded by the console layout, refreshed through /api/sidebar). */
export const sidebarSchema = z.object({
  workspaceName: z.string().nullable(),
  /** The viewer's id as the API knows it: tells "my" live audits from the team's. */
  actorId: z.string().nullable().default(null),
  gate2: z.array(
    z.object({ id: z.string(), runId: z.string(), method: z.string(), url: z.string(), deadlineAt: iso, createdAt: iso.optional() }),
  ),
  plans: z.array(z.object({ id: z.string(), assetName: z.string(), createdAt: iso })),
  releases: z.array(z.object({ id: z.string(), title: z.string(), assetName: z.string().nullable() })),
  live: z.array(runSummarySchema),
  earlier: z.array(runSummarySchema),
  /** Exact counts from /dashboard; null while the API does not send them (the lists above are then the counts). */
  counts: z
    .object({ gate1: z.number(), gate2: z.number(), gate3: z.number(), live: z.number() })
    .nullable()
    .default(null),
});
export type SidebarData = z.infer<typeof sidebarSchema>;

export function toSidebar(d: Dashboard): SidebarData {
  return {
    workspaceName: d.tenant?.name ?? null,
    actorId: d.actor.id,
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
    live: d.liveRuns ?? d.runs.filter((r) => LIVE_RUN_STATES.includes(r.state)),
    // Newest first by the time the sidebar shows (when it ended), not by when it started.
    earlier: d.runs
      .filter((r) => !LIVE_RUN_STATES.includes(r.state))
      .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
      .slice(0, EARLIER_RUNS),
    counts:
      d.pendingCounts === undefined
        ? null
        : {
            gate1: d.pendingCounts.gate1,
            gate2: d.pendingCounts.gate2,
            gate3: d.pendingCounts.gate3,
            live: d.pendingCounts.live,
          },
  };
}
