import { TENANT_A } from '../fixtures.test-helpers.js';

import type { PlanValidationStore } from './ports.js';
import type {
  PlanAuthorisation,
  PlanRunBudgets,
  PlanValidatedAuditEvent,
  PlanValidationSnapshot,
  TestCaseRow,
  TestPlanRow,
} from '@blackwing/db';

const HTTPS_PORT = 443;
const HTTP_PORT = 80;

const PLAN_ID = '0198f0a0-0000-7000-8000-0000000000c1';
export const CASE_ID = '0198f0a0-0000-7000-8000-0000000000c2';
export const SECOND_CASE_ID = '0198f0a0-0000-7000-8000-0000000000c3';
export const SA_ID = '0198f0a0-0000-7000-8000-0000000000d1';
const ASSET_ID = '0198f0a0-0000-7000-8000-0000000000f1';
const RUN_ID = '0198f0a0-0000-7000-8000-0000000000e1';

/** Fixed clock of the validation tests: inside the SA window below. */
export const NOW = new Date('2026-10-30T12:00:00.000Z');

const TIME = new Date('2026-10-01T00:00:00.000Z');

/** A standing authorisation that is active at {@link NOW}, pre-approving no class and allowing active_safe. */
export function activeAuthorisation(overrides: Partial<PlanAuthorisation> = {}): PlanAuthorisation {
  return {
    id: SA_ID,
    status: 'active',
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    assetIds: [ASSET_ID],
    scopeRules: {
      rules: [{ effect: 'include', host: '*.example.test', ports: [HTTPS_PORT, HTTP_PORT] }],
    },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: [],
    defaultBudgets: { maxRequests: 100, maxBytes: 1_000_000 },
    ...overrides,
  };
}

export const RUN_BUDGETS: PlanRunBudgets = { maxRequests: 500 };

/** A stored test case that passes every check against {@link activeAuthorisation}. */
export function caseRow(overrides: Partial<TestCaseRow> = {}): TestCaseRow {
  return {
    id: CASE_ID,
    tenantId: TENANT_A,
    testPlanId: PLAN_ID,
    class: 'active_safe',
    title: 'Reflected parameter in search',
    owaspRefs: ['A03:2021'],
    wstgRefs: ['WSTG-INPV-01'],
    asvsRefs: ['5.3.3'],
    cweCandidates: ['CWE-79'],
    targets: ['https://app.example.test/search'],
    roles: ['anonymous'],
    budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 2, maxBytes: 100_000 },
    oracle: { type: 'response.contains', params: { needle: 'probe' } },
    negativeControl: { type: 'response.contains', params: { needle: 'nothing' } },
    status: 'proposed',
    statusReason: null,
    createdAt: TIME,
    updatedAt: TIME,
    ...overrides,
  };
}

export function planRow(overrides: Partial<TestPlanRow> = {}): TestPlanRow {
  return {
    id: PLAN_ID,
    tenantId: TENANT_A,
    runId: RUN_ID,
    version: 1,
    status: 'draft',
    createdBy: null,
    createdAt: TIME,
    updatedAt: TIME,
    ...overrides,
  };
}

/** A snapshot of a valid plan: one active_safe case, the active SA, the run budget and the role matrix roles. */
export function validSnapshot(
  overrides: Partial<PlanValidationSnapshot> & { readonly cases?: readonly TestCaseRow[] } = {},
): PlanValidationSnapshot {
  return {
    plan: planRow(),
    cases: [caseRow()],
    saId: SA_ID,
    runBudgets: RUN_BUDGETS,
    authorisation: activeAuthorisation(),
    knownRoles: ['anonymous', 'customer'],
    ...overrides,
  };
}

export interface MemoryPlanValidationStore extends PlanValidationStore {
  /** Audit events written by `recordValidated`, in order. */
  readonly events: PlanValidatedAuditEvent[];
  /** Makes the next audit write fail, to prove a failed audit returns no verdict. */
  failAudit: boolean;
  seed(snapshot: PlanValidationSnapshot): void;
}

/** In-memory validation store: snapshots are per tenant and plan, so cross-tenant reads are absent. */
export function memoryPlanValidationStore(): MemoryPlanValidationStore {
  const snapshots = new Map<string, PlanValidationSnapshot>();
  const events: PlanValidatedAuditEvent[] = [];
  const store: MemoryPlanValidationStore = {
    events,
    failAudit: false,
    seed(snapshot) {
      snapshots.set(`${snapshot.plan.tenantId}:${snapshot.plan.id}`, snapshot);
    },
    snapshot(tenantId, planId) {
      return Promise.resolve(snapshots.get(`${tenantId}:${planId}`));
    },
    recordValidated(event) {
      if (store.failAudit) return Promise.reject(new Error('audit unavailable'));
      events.push(event);
      return Promise.resolve();
    },
  };
  return store;
}
