import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  INTRUSIVENESS_CLASSES,
  RUN_STATES,
  TEST_CASE_STATUSES,
  TEST_PLAN_STATUSES,
} from '@blackwing/contracts';

import { runs } from './runs.js';
import { testCases, testPlans } from './test-plans.js';

/** Enum and tenant-anchor drift checks between the Drizzle schema and the §7 contracts (PLAN-001). */
describe('test plan schema', () => {
  it('stores the §7 enum values exactly (test_cases.class and status)', () => {
    expect(testCases.class.enumValues).toEqual([...INTRUSIVENESS_CLASSES]);
    expect(testCases.status.enumValues).toEqual([...TEST_CASE_STATUSES]);
    expect([...TEST_CASE_STATUSES].sort()).toEqual(
      [
        'approved',
        'blocked',
        'executed',
        'executing',
        'failed',
        'model_declined',
        'not_applicable',
        'proposed',
        'removed',
        'skipped',
      ].sort(),
    );
  });

  it('stores the test plan status enum: draft, proposed, approved, superseded', () => {
    expect(testPlans.status.enumValues).toEqual([...TEST_PLAN_STATUSES]);
    expect([...TEST_PLAN_STATUSES]).toEqual(['draft', 'proposed', 'approved', 'superseded']);
  });

  it('keeps the minimal runs table in step with the run state machine (§3.3)', () => {
    expect(runs.state.enumValues).toEqual([...RUN_STATES]);
  });

  it('gives every table a tenant anchor that is not null, and defaults to a fresh plan', () => {
    for (const table of [runs, testPlans, testCases]) {
      const column = getTableConfig(table).columns.find((c) => c.name === 'tenant_id');
      expect(column?.notNull).toBe(true);
    }
    expect(testPlans.status.default).toBe('draft');
    expect(testCases.status.default).toBe('proposed');
  });

  it('names the (run_id, version) unique constraint and the test case foreign keys', () => {
    const planConfig = getTableConfig(testPlans);
    expect(planConfig.uniqueConstraints.map((u) => u.name)).toContain(
      'test_plans_run_id_version_unique',
    );
    const caseConfig = getTableConfig(testCases);
    expect(caseConfig.foreignKeys.map((fk) => fk.getName())).toContain('test_cases_test_plan_fk');
    expect(planConfig.foreignKeys.map((fk) => fk.getName())).toContain('test_plans_run_fk');
  });
});
