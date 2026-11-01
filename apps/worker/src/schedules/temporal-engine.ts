import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  type ScheduleClient,
} from '@temporalio/client';

import { ASSESSMENT_RUN_WORKFLOW, RUN_TASK_QUEUE, type DesiredScheduleFacts } from './spec.js';

import type { ActualScheduleFacts, TemporalScheduleEngine } from './ports.js';

/**
 * The Temporal binding of {@link TemporalScheduleEngine}, over the SDK's `ScheduleClient`. The only errors it
 * swallows are the two that carry meaning here (already exists, not found); every other error reaches the manager,
 * which decides what it means for the row.
 */

function specOf(facts: DesiredScheduleFacts) {
  return { cronExpressions: [facts.cronExpr], timezone: facts.timezone };
}

function actionOf(facts: DesiredScheduleFacts) {
  return {
    type: 'startWorkflow' as const,
    workflowType: ASSESSMENT_RUN_WORKFLOW,
    taskQueue: RUN_TASK_QUEUE,
    args: [facts.input],
  };
}

function policiesOf(facts: DesiredScheduleFacts) {
  return { overlap: facts.overlap, catchupWindow: facts.catchupWindowMs, pauseOnFailure: true };
}

/**
 * Temporal returns a described spec as calendars, not the cron string it was built from, so the cron expression is
 * kept in the schedule's memo and read back from there for drift detection. The zone comes back as `timezone`.
 */
function memoOf(facts: DesiredScheduleFacts) {
  return { cronExpr: facts.cronExpr };
}

export function createTemporalScheduleEngine(client: ScheduleClient): TemporalScheduleEngine {
  return {
    async create(scheduleId, facts) {
      try {
        await client.create({
          scheduleId,
          spec: specOf(facts),
          action: actionOf(facts),
          policies: policiesOf(facts),
          memo: memoOf(facts),
          state: { paused: facts.paused },
        });
        return true;
      } catch (err) {
        if (err instanceof ScheduleAlreadyRunning) return false;
        throw err;
      }
    },

    async update(scheduleId, facts) {
      // Temporal does not apply a new memo on update, so the cron that drift detection reads would go stale. The
      // schedule is recreated on the desired definition instead, keeping the paused state it holds. Should the process
      // stop between the two calls, reconciliation recreates the schedule from its row.
      const handle = client.getHandle(scheduleId);
      const { state } = await handle.describe();
      await handle.delete();
      await client.create({
        scheduleId,
        spec: specOf(facts),
        action: actionOf(facts),
        policies: policiesOf(facts),
        memo: memoOf(facts),
        state: { paused: state.paused },
      });
    },

    async pause(scheduleId, note) {
      await client.getHandle(scheduleId).pause(note);
    },

    async unpause(scheduleId, note) {
      await client.getHandle(scheduleId).unpause(note);
    },

    async delete(scheduleId) {
      try {
        await client.getHandle(scheduleId).delete();
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return;
        throw err;
      }
    },

    async describe(scheduleId): Promise<ActualScheduleFacts | null> {
      try {
        const description = await client.getHandle(scheduleId).describe();
        return {
          paused: description.state.paused,
          cronExpr: typeof description.memo?.cronExpr === 'string' ? description.memo.cronExpr : '',
          timezone: description.spec.timezone ?? '',
          overlap: description.policies.overlap ?? '',
          catchupWindowMs: description.policies.catchupWindow,
          input: description.action.args?.[0],
        };
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return null;
        throw err;
      }
    },

    async listIds() {
      const ids: string[] = [];
      for await (const summary of client.list()) ids.push(summary.scheduleId);
      return ids;
    },
  };
}
