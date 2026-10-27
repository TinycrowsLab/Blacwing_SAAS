import {
  PLATFORM_OPERATOR,
  PLATFORM_OPERATOR_PERMISSIONS,
  type RunState,
} from '@blackwing/contracts';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { FixedClock } from '@blackwing/time';

import {
  createInMemoryTenantDirectory,
  InMemoryOperatorKillAuditSink,
  InMemoryOperatorKillEventStore,
  RecordingOperatorKillSignaler,
} from './memory.js';
import { createOperatorKillMetrics } from './metrics.js';
import { OperatorKillService } from './service.js';
import { tracing } from '../kill/fixtures.test-helpers.js';

import type { OperatorKillAuditSink, OperatorKillSignaler, OperatorPrincipal } from './ports.js';
import type { KillRunRow, KillSessionRow, KillTargetReader } from '@blackwing/domain';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

const gen = createUuidV7Generator();
export const uuid = (): string => gen();

export const TENANT_A = uuid();
export const TENANT_B = uuid();
export const RUN_A = uuid();
export const RUN_A_DONE = uuid();
export const RUN_B = uuid();
export const SLUG_A = 'acme';
const SLUG_B = 'globex';
export const OPERATOR_ID = 'op-0001';

export const operator = (overrides: Partial<OperatorPrincipal> = {}): OperatorPrincipal => ({
  id: OPERATOR_ID,
  role: PLATFORM_OPERATOR,
  permissions: PLATFORM_OPERATOR_PERMISSIONS,
  ...overrides,
});

/** A tenant member: a real session, but not a platform operator. */
export const tenantMember = (): OperatorPrincipal => ({
  id: uuid(),
  role: 'org_admin',
  permissions: ['run:read', 'kill:trigger'],
});

interface WorldRun {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
}

const RUNS: readonly WorldRun[] = [
  { id: RUN_A, tenantId: TENANT_A, state: 'executing' },
  { id: RUN_A_DONE, tenantId: TENANT_A, state: 'completed' },
  { id: RUN_B, tenantId: TENANT_B, state: 'executing' },
];

const sessionOf = (tenantId: string, runId: string, n: string): KillSessionRow => ({
  tenantId,
  runId,
  sessionId: `sess-${n}`,
  sandboxId: `sbx-${n}`,
  virtualKeyId: `vk-${n}`,
  workflowId: `wf-session-${n}`,
  testCaseId: `tc${n}`,
  roleId: 'r1',
});

const SESSIONS: readonly KillSessionRow[] = [
  sessionOf(TENANT_A, RUN_A, 'a1'),
  sessionOf(TENANT_A, RUN_A, 'a2'),
  sessionOf(TENANT_B, RUN_B, 'b1'),
];

/** A platform-operator reader over the fixed world: sees every tenant, as the operator role does. */
function operatorReader(operatorId: string, runs: readonly WorldRun[] = RUNS): KillTargetReader {
  return {
    context: { kind: 'operator', role: PLATFORM_OPERATOR, operatorId },
    listRuns(query, exclude) {
      const rows: KillRunRow[] = runs
        .filter((r) => !exclude.includes(r.state))
        .filter((r) => (query.by === 'tenant' ? r.tenantId === query.tenantId : true))
        .map((r) => ({ ...r, assetIds: [], workflowId: `wf-run-${r.id}` }));
      return Promise.resolve(rows);
    },
    listSessions: (runIds) => Promise.resolve(SESSIONS.filter((s) => runIds.includes(s.runId))),
    listSubtasks: () => Promise.resolve([]),
  };
}

export interface Harness {
  readonly service: OperatorKillService;
  readonly store: InMemoryOperatorKillEventStore;
  readonly audit: InMemoryOperatorKillAuditSink;
  readonly signaler: RecordingOperatorKillSignaler;
  readonly metrics: ReturnType<typeof createOperatorKillMetrics>;
  readonly logs: string[];
  readonly spans: InMemorySpanExporter;
  readonly clock: FixedClock;
}

export function harness(
  options: {
    readonly signaler?: OperatorKillSignaler;
    readonly audit?: OperatorKillAuditSink;
    readonly runs?: readonly WorldRun[];
  } = {},
): Harness {
  const spans = tracing();
  const logs: string[] = [];
  const store = new InMemoryOperatorKillEventStore();
  const audit = new InMemoryOperatorKillAuditSink();
  const signaler = new RecordingOperatorKillSignaler();
  const metrics = createOperatorKillMetrics();
  const clock = new FixedClock('2026-10-20T10:00:00.000Z');
  const service = new OperatorKillService({
    store,
    tenants: createInMemoryTenantDirectory([
      { id: TENANT_A, slug: SLUG_A },
      { id: TENANT_B, slug: SLUG_B },
    ]),
    targets: {
      withOperatorReader: (operatorId, fn) => fn(operatorReader(operatorId, options.runs)),
    },
    signaler: options.signaler ?? signaler,
    audit: options.audit ?? audit,
    logger: createLogger('operator-kill-test', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => logs.push(line) },
    }),
    metrics,
    clock,
  });
  return { service, store, audit, signaler, metrics, logs, spans, clock };
}
