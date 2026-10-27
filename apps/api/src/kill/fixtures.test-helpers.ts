import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { FixedClock } from '@blackwing/time';

import {
  createInMemoryKillResources,
  InMemoryKillAuditSink,
  InMemoryKillEventStore,
  RecordingKillSignaler,
} from './memory.js';
import { createKillMetrics } from './metrics.js';
import { createCedarKillPolicy } from './policy.js';
import { KillService } from './service.js';

import type { KillPrincipal, KillPropagationSignaler } from './ports.js';
import type { RunState } from '@blackwing/contracts';
import type { KillRunRow, KillSessionRow, KillTargetReader } from '@blackwing/domain';

const gen = createUuidV7Generator();
export const uuid = (): string => gen();

export const TENANT_A = uuid();
export const TENANT_B = uuid();
export const OWNER = uuid();
export const OTHER_USER = uuid();
export const OWNED_ASSET = uuid();
export const UNOWNED_ASSET = uuid();
const ASSET_B = uuid();
export const LIVE_RUN = uuid();
export const DONE_RUN = uuid();
export const RUN_B = uuid();

export const principal = (
  roles: readonly string[],
  overrides: Partial<KillPrincipal> = {},
): KillPrincipal => ({ type: 'user', id: OWNER, tenantId: TENANT_A, roles, ...overrides });

interface WorldRun {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
  readonly assetIds: readonly string[];
}

const RUNS: readonly WorldRun[] = [
  { id: LIVE_RUN, tenantId: TENANT_A, state: 'executing', assetIds: [OWNED_ASSET] },
  { id: DONE_RUN, tenantId: TENANT_A, state: 'completed', assetIds: [UNOWNED_ASSET] },
  { id: RUN_B, tenantId: TENANT_B, state: 'executing', assetIds: [ASSET_B] },
];

const SESSIONS: readonly KillSessionRow[] = [
  {
    tenantId: TENANT_A,
    runId: LIVE_RUN,
    sessionId: 'sess-1',
    sandboxId: 'sbx-1',
    virtualKeyId: 'vk-1',
    workflowId: 'wf-session-1',
    testCaseId: 'tc1',
    roleId: 'r1',
  },
];

/** A tenant-scoped reader over the fixed world, behaving like an RLS transaction. */
function readerFor(tenantId: string): KillTargetReader {
  return {
    context: { kind: 'tenant', tenantId },
    listRuns(query, exclude) {
      const rows: KillRunRow[] = RUNS.filter(
        (r) => r.tenantId === tenantId && !exclude.includes(r.state),
      )
        .filter((r) =>
          query.by === 'run'
            ? r.id === query.runId
            : query.by === 'asset'
              ? r.assetIds.includes(query.assetId)
              : true,
        )
        .map((r) => ({ ...r, workflowId: `wf-run-${r.id}` }));
      return Promise.resolve(rows);
    },
    listSessions(runIds) {
      return Promise.resolve(
        SESSIONS.filter((s) => s.tenantId === tenantId && runIds.includes(s.runId)),
      );
    },
    listSubtasks() {
      return Promise.resolve([]);
    },
  };
}

export interface Harness {
  readonly service: KillService;
  readonly store: InMemoryKillEventStore;
  readonly audit: InMemoryKillAuditSink;
  readonly signaler: RecordingKillSignaler;
  readonly metrics: ReturnType<typeof createKillMetrics>;
  readonly logs: string[];
  readonly spans: InMemorySpanExporter;
  readonly clock: FixedClock;
}

let tracingReady: InMemorySpanExporter | null = null;
/** One global in-memory tracer for the test process (spans are asserted by name). */
export function tracing(): InMemorySpanExporter {
  if (tracingReady !== null) return tracingReady;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  tracingReady = exporter;
  return exporter;
}

export function harness(options: { readonly signaler?: KillPropagationSignaler } = {}): Harness {
  const spans = tracing();
  const logs: string[] = [];
  const store = new InMemoryKillEventStore();
  const audit = new InMemoryKillAuditSink();
  const signaler = new RecordingKillSignaler();
  const metrics = createKillMetrics();
  const clock = new FixedClock('2026-10-20T10:00:00.000Z');
  const service = new KillService({
    store,
    resources: createInMemoryKillResources({
      runs: RUNS.map((r) => ({ id: r.id, tenantId: r.tenantId })),
      assets: [
        { id: OWNED_ASSET, tenantId: TENANT_A, ownerUserIds: [OWNER] },
        { id: UNOWNED_ASSET, tenantId: TENANT_A, ownerUserIds: [OTHER_USER] },
        { id: ASSET_B, tenantId: TENANT_B, ownerUserIds: [OWNER] },
      ],
    }),
    targets: { withTenantReader: (tenantId, fn) => fn(readerFor(tenantId)) },
    signaler: options.signaler ?? signaler,
    audit,
    policy: createCedarKillPolicy(),
    logger: createLogger('kill-test', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => logs.push(line) },
    }),
    metrics,
    clock,
  });
  return { service, store, audit, signaler, metrics, logs, spans, clock };
}
