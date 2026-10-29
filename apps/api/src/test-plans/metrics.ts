import { Counter, type Registry } from 'prom-client';

/** The mutating operations counted by `test_plan_mutations_total{op}`. */
export type TestPlanMutation = 'create_version' | 'add_case' | 'update_case' | 'remove_case';

export interface TestPlanMetrics {
  /** Counts committed mutations by operation; a refused or no-op call does not count. */
  mutated(op: TestPlanMutation): void;
}

/** `test_plan_mutations_total{op}` on the app's registry. The label set is closed, so cardinality is bounded. */
export function createTestPlanMetrics(registry: Registry): TestPlanMetrics {
  const counter = new Counter({
    name: 'test_plan_mutations_total',
    help: 'Test plan and test case mutations committed, by operation.',
    labelNames: ['op'] as const,
    registers: [registry],
  });
  return {
    mutated: (op) => {
      counter.inc({ op });
    },
  };
}
