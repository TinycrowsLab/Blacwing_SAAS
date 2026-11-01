import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { ASSET, SA, SCHEDULE, TENANT, scheduleFixture } from './fixtures.js';
import {
  ASSESSMENT_RUN_WORKFLOW,
  catchupWindowMs,
  desiredScheduleFacts,
  RUN_TASK_QUEUE,
  scheduleRunInput,
  temporalOverlapPolicy,
  temporalScheduleIdFor,
} from './spec.js';

describe('temporalScheduleIdFor', () => {
  it('is sched-{tenantId}-{scheduleId}, deterministic per row', () => {
    expect(temporalScheduleIdFor(TENANT, SCHEDULE)).toBe(`sched-${TENANT}-${SCHEDULE}`);
    expect(temporalScheduleIdFor(TENANT, SCHEDULE)).toBe(temporalScheduleIdFor(TENANT, SCHEDULE));
  });
});

describe('temporalOverlapPolicy', () => {
  it.each([
    ['skip', 'SKIP'],
    ['buffer_one', 'BUFFER_ONE'],
    ['cancel_other', 'CANCEL_OTHER'],
    ['allow', 'ALLOW_ALL'],
  ] as const)('maps %s to %s', (policy, expected) => {
    expect(temporalOverlapPolicy(policy)).toBe(expected);
  });
});

describe('catchupWindowMs', () => {
  it('gives skip the smallest window Temporal accepts, so no missed fire is taken', () => {
    expect(catchupWindowMs('skip', 720)).toBe(10_000);
  });

  it('gives fire_once the configured window in milliseconds', () => {
    expect(catchupWindowMs('fire_once', 60)).toBe(3_600_000);
  });

  it('never gives fire_once less than a minute', () => {
    expect(catchupWindowMs('fire_once', 0)).toBe(60_000);
  });
});

describe('scheduleRunInput', () => {
  it('carries references, the schedule id and the schedule trigger, and no secrets', () => {
    const input = scheduleRunInput(scheduleFixture());

    expect(input).toEqual({
      tenantId: TENANT,
      scheduleId: SCHEDULE,
      assetIds: [ASSET],
      saId: SA,
      mode: 'grey',
      objective: null,
      budgets: { max_requests: 100 },
      trigger: 'schedule',
    });
  });
});

describe('desiredScheduleFacts', () => {
  it('normalises the cron expression and keeps the zone', () => {
    const facts = desiredScheduleFacts(scheduleFixture({ cronExpr: '  0   2 * * *  ' }), false);

    expect(facts.cronExpr).toBe('0 2 * * *');
    expect(facts.timezone).toBe('Europe/London');
  });

  it('expands a shortcut to its five-field form', () => {
    expect(desiredScheduleFacts(scheduleFixture({ cronExpr: '@daily' }), false).cronExpr).toBe(
      '0 0 * * *',
    );
  });

  it('is paused for a disabled row or a suspended tenant, and running otherwise', () => {
    expect(desiredScheduleFacts(scheduleFixture(), false).paused).toBe(false);
    expect(desiredScheduleFacts(scheduleFixture({ enabled: false }), false).paused).toBe(true);
    expect(desiredScheduleFacts(scheduleFixture(), true).paused).toBe(true);
  });

  it('maps the overlap policy and the catch-up window of the row', () => {
    const facts = desiredScheduleFacts(
      scheduleFixture({
        overlapPolicy: 'buffer_one',
        catchUpPolicy: 'fire_once',
        catchUpWindowMinutes: 30,
      }),
      false,
    );

    expect(facts.overlap).toBe('BUFFER_ONE');
    expect(facts.catchupWindowMs).toBe(30 * 60_000);
  });

  it('refuses an expression more often than hourly (SCHEDULE_TOO_FREQUENT)', () => {
    const err = appErrorOf(() =>
      desiredScheduleFacts(scheduleFixture({ cronExpr: '*/10 * * * *' }), false),
    );
    expect(err.code).toBe('SCHEDULE_TOO_FREQUENT');
  });

  it('refuses an unknown time zone (SCHEDULE_TZ_INVALID)', () => {
    const err = appErrorOf(() =>
      desiredScheduleFacts(scheduleFixture({ timezone: 'Not/AZone' }), false),
    );
    expect(err.code).toBe('SCHEDULE_TZ_INVALID');
  });

  it('refuses a fixed-offset zone, which the domain never accepts', () => {
    const err = appErrorOf(() =>
      desiredScheduleFacts(scheduleFixture({ timezone: '+03:00' }), false),
    );
    expect(err.code).toBe('SCHEDULE_TZ_INVALID');
  });
});

describe('run workflow binding', () => {
  it('starts AssessmentRunWorkflow on the run-orchestration queue', () => {
    expect(ASSESSMENT_RUN_WORKFLOW).toBe('AssessmentRunWorkflow');
    expect(RUN_TASK_QUEUE).toBe('run-orchestration');
  });
});

/** The AppError a refused call throws; a call that does not refuse fails the test. */
function appErrorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}
