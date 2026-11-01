import type {
  ScheduleStateChange,
  ScheduleAudit,
  ScheduleStore,
  TemporalScheduleEngine,
} from './ports.js';
import type { DesiredScheduleFacts } from './spec.js';
import type { Schedule } from '@blackwing/contracts';

/** Test doubles for the ScheduleManager ports: an in-memory store, engine and tenant gate, all deterministic. */

export const TENANT = '0190f2d4-7c1a-7b2e-8f00-00000000000a';
export const OTHER_TENANT = '0190f2d4-7c1a-7b2e-8f00-00000000000b';
export const SCHEDULE = '0190f2d4-7c1a-7b2e-8f00-0000000000a1';
export const SCHEDULE_2 = '0190f2d4-7c1a-7b2e-8f00-0000000000a2';
export const SA = '0190f2d4-7c1a-7b2e-8f00-0000000000b1';
export const ASSET = '0190f2d4-7c1a-7b2e-8f00-0000000000c1';
const USER = '0190f2d4-7c1a-7b2e-8f00-0000000000d1';
export const NOW = new Date('2026-10-31T10:00:00.000Z');
/** One step of the fixture store's clock, in milliseconds. */
const CLOCK_STEP_MS = 1_000;

export const ACTOR = { type: 'user', id: USER } as const;

export function scheduleFixture(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE,
    tenantId: TENANT,
    publicId: 'sched_00000000000000000000000000',
    name: 'Nightly external',
    assetIds: [ASSET],
    saId: SA,
    mode: 'grey',
    objective: null,
    cronExpr: '0 2 * * *',
    timezone: 'Europe/London',
    overlapPolicy: 'skip',
    catchUpPolicy: 'skip',
    catchUpWindowMinutes: 60,
    budgets: { max_requests: 100 },
    enabled: true,
    temporalScheduleId: null,
    lastFireAt: null,
    nextFireAt: null,
    createdBy: USER,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    ...overrides,
  };
}

export class MemoryScheduleStore implements ScheduleStore {
  readonly rows = new Map<string, Schedule>();
  readonly audits: { tenantId: string; scheduleId: string; event: ScheduleAudit }[] = [];
  private clock = 0;

  constructor(initial: Schedule[] = []) {
    for (const row of initial) this.rows.set(this.key(row.tenantId, row.id), row);
  }

  private key(tenantId: string, id: string): string {
    return `${tenantId}/${id}`;
  }

  get(tenantId: string, id: string): Promise<Schedule | null> {
    return Promise.resolve(this.rows.get(this.key(tenantId, id)) ?? null);
  }

  list(tenantId: string): Promise<Schedule[]> {
    return Promise.resolve([...this.rows.values()].filter((row) => row.tenantId === tenantId));
  }

  write(
    tenantId: string,
    id: string,
    change: ScheduleStateChange,
    options: { expectedUpdatedAt?: string; audit?: ScheduleAudit },
  ): Promise<Schedule> {
    const current = this.rows.get(this.key(tenantId, id));
    if (current === undefined) return Promise.reject(new Error('no row'));
    if (
      options.expectedUpdatedAt !== undefined &&
      options.expectedUpdatedAt !== current.updatedAt
    ) {
      return Promise.reject(new Error('SCHEDULE_CONFLICT'));
    }
    this.clock += 1;
    const definition = change.definition ?? {};
    const next: Schedule = {
      ...current,
      ...definition,
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.temporalScheduleId === undefined
        ? {}
        : { temporalScheduleId: change.temporalScheduleId }),
      ...(change.nextFireAt === undefined
        ? {}
        : { nextFireAt: change.nextFireAt?.toISOString() ?? null }),
      updatedAt: new Date(
        Date.parse('2026-10-31T09:00:00.000Z') + this.clock * CLOCK_STEP_MS,
      ).toISOString(),
    };
    this.rows.set(this.key(tenantId, id), next);
    if (options.audit !== undefined)
      this.audits.push({ tenantId, scheduleId: id, event: options.audit });
    return Promise.resolve(next);
  }

  delete(tenantId: string, id: string, audit: ScheduleAudit): Promise<void> {
    if (!this.rows.delete(this.key(tenantId, id))) return Promise.reject(new Error('no row'));
    this.audits.push({ tenantId, scheduleId: id, event: audit });
    return Promise.resolve();
  }
}

/** Temporal, in memory. `failing` makes the named operations reject, to exercise the failure paths. */
export class MemoryEngine implements TemporalScheduleEngine {
  readonly schedules = new Map<string, DesiredScheduleFacts & { paused: boolean }>();
  readonly calls: string[] = [];
  failing = new Set<string>();

  private guard(op: string): void {
    this.calls.push(op);
    if (this.failing.has(op)) throw new Error(`temporal ${op} unavailable`);
  }

  create(scheduleId: string, facts: DesiredScheduleFacts): Promise<boolean> {
    this.guard('create');
    if (this.schedules.has(scheduleId)) return Promise.resolve(false);
    this.schedules.set(scheduleId, { ...facts, paused: facts.paused });
    return Promise.resolve(true);
  }

  update(scheduleId: string, facts: DesiredScheduleFacts): Promise<void> {
    this.guard('update');
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) return Promise.reject(new Error('not found'));
    this.schedules.set(scheduleId, { ...facts, paused: existing.paused });
    return Promise.resolve();
  }

  pause(scheduleId: string): Promise<void> {
    this.guard('pause');
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) return Promise.reject(new Error('not found'));
    existing.paused = true;
    return Promise.resolve();
  }

  unpause(scheduleId: string): Promise<void> {
    this.guard('unpause');
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) return Promise.reject(new Error('not found'));
    existing.paused = false;
    return Promise.resolve();
  }

  delete(scheduleId: string): Promise<void> {
    this.guard('delete');
    this.schedules.delete(scheduleId);
    return Promise.resolve();
  }

  describe(scheduleId: string) {
    const existing = this.schedules.get(scheduleId);
    if (existing === undefined) return Promise.resolve(null);
    return Promise.resolve({ ...existing });
  }

  listIds(): Promise<string[]> {
    return Promise.resolve([...this.schedules.keys()]);
  }
}

export class RecordingMetrics {
  readonly ops: { op: string; result: string }[] = [];
  repairTotal = 0;
  op(labels: { op: string; result: 'ok' | 'error' }): void {
    this.ops.push(labels);
  }
  repairs(count: number): void {
    this.repairTotal += count;
  }
}

export function silentLog() {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop };
}
