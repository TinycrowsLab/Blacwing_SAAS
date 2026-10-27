import { metrics } from '@opentelemetry/api';

import type { PlanningMetrics } from './ports.js';

/**
 * `blackwing_plan_testcases_total{class}`, `blackwing_gate1_decisions_total{decision,auto}` and
 * `blackwing_gate1_wait_seconds`.
 */
export function createOtelPlanningMetrics(): PlanningMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const testCases = meter.createCounter('blackwing_plan_testcases_total', {
    description: 'Test cases proposed by the planner, by intrusiveness class',
  });
  const decisions = meter.createCounter('blackwing_gate1_decisions_total', {
    description: 'Gate 1 decisions by decision and whether they were automatic',
  });
  const wait = meter.createHistogram('blackwing_gate1_wait_seconds', {
    description: 'Time a plan waited at Gate 1 before a human decided',
    unit: 's',
  });
  return {
    testCases: (testClass, count) => {
      testCases.add(count, { class: testClass });
    },
    gate1Decision: (decision, auto) => {
      decisions.add(1, { decision, auto });
    },
    gate1Wait: (seconds) => {
      wait.record(seconds);
    },
  };
}
