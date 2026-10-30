import { z } from 'zod';

import {
  engagementDispatchInputSchema,
  engagementDispatchResultSchema,
  engagementMarkTestCaseInputSchema,
  engagementMarkTestCaseResultSchema,
  engagementMentorReviewInputSchema,
  engagementMentorReviewResultSchema,
  engagementOpenSubtasksSchema,
  engagementScopeExceptionInputSchema,
  engagementScopeExceptionResultSchema,
  engagementStateSchema,
  engagementSubtaskResultSchema,
  uuidV7Schema,
} from '@blackwing/contracts';

import { defineTool, type ToolDefinition } from '../tool.js';

import type { EngagementMetrics } from './metrics.js';

/**
 * The orchestrator's engagement tools (MCP-012, #677; CONTEXT_PACK §4.2). Every tool is a thin call to the
 * Run Broker with the run-scoped token, never a local side effect. The broker owns the decisions: a dispatch
 * signals the Run Controller, which starts the specialist in a new sandbox. No tool here starts work
 * in-process, and none uses the native `Agent`/`Task` tool for cross-sandbox dispatch (§4.2).
 */

const EMPTY_INPUT = z.strictObject({});
const SUBTASK_RESULT_INPUT = z.strictObject({ subtaskId: uuidV7Schema });

/** The seven engagement tools of the `engagement` server. Read tools are marked `readOnly`. */
export function createEngagementTools(metrics: EngagementMetrics): readonly ToolDefinition[] {
  return [
    defineTool({
      server: 'engagement',
      name: 'get_engagement_state',
      description:
        'Read the run phase, test-case counts by status, subtask counts by status and confirmed findings.',
      inputSchema: EMPTY_INPUT,
      outputSchema: engagementStateSchema,
      readOnly: true,
      handler: async (_input, context) => {
        metrics.reads.inc({ tool: 'get_engagement_state' });
        return {
          ok: true,
          data: await context.broker.get('engagement/state', engagementStateSchema),
        };
      },
    }),
    defineTool({
      server: 'engagement',
      name: 'list_open_subtasks',
      description:
        'List approved test cases that have no subtask yet, with the personas whose mandate covers their standards.',
      inputSchema: EMPTY_INPUT,
      outputSchema: engagementOpenSubtasksSchema,
      readOnly: true,
      handler: async (_input, context) => {
        metrics.reads.inc({ tool: 'list_open_subtasks' });
        return {
          ok: true,
          data: await context.broker.get('engagement/subtasks/open', engagementOpenSubtasksSchema),
        };
      },
    }),
    defineTool({
      server: 'engagement',
      name: 'dispatch_subtask',
      description:
        'Dispatch one eligible specialist for an approved test case. The brief must be self-contained: the specialist ' +
        'starts cold in its own sandbox and sees only this brief. A refusal says why, so back off or re-plan.',
      inputSchema: engagementDispatchInputSchema,
      outputSchema: engagementDispatchResultSchema,
      readOnly: false,
      handler: async (input, context) => {
        const outcome = await context.broker.post(
          'engagement/dispatch',
          input,
          engagementDispatchResultSchema,
        );
        metrics.dispatch.inc({ outcome: outcome.accepted ? 'accepted' : 'rejected' });
        return { ok: true, data: outcome };
      },
    }),
    defineTool({
      server: 'engagement',
      name: 'get_subtask_result',
      description:
        'Read a subtask result. A subtask still in flight reports its status with pending set; that is not an error.',
      inputSchema: SUBTASK_RESULT_INPUT,
      outputSchema: engagementSubtaskResultSchema,
      readOnly: true,
      handler: async (input, context) => {
        metrics.reads.inc({ tool: 'get_subtask_result' });
        return {
          ok: true,
          data: await context.broker.get(
            `engagement/subtasks/${input.subtaskId}/result`,
            engagementSubtaskResultSchema,
          ),
        };
      },
    }),
    defineTool({
      server: 'engagement',
      name: 'request_mentor_review',
      description:
        'Raise a mentor review for a stalled subtask. The mentor advises only: it never allows or denies anything.',
      inputSchema: engagementMentorReviewInputSchema,
      outputSchema: engagementMentorReviewResultSchema,
      readOnly: false,
      handler: async (input, context) => ({
        ok: true,
        data: await context.broker.post(
          'engagement/mentor-reviews',
          input,
          engagementMentorReviewResultSchema,
        ),
      }),
    }),
    defineTool({
      server: 'engagement',
      name: 'mark_test_case_status',
      description:
        'Report a test case outcome: executing, executed, skipped, blocked, failed, model_declined or not_applicable. ' +
        'Give a reason. The broker refuses a status the test case cannot move to.',
      inputSchema: engagementMarkTestCaseInputSchema,
      outputSchema: engagementMarkTestCaseResultSchema,
      readOnly: false,
      handler: async (input, context) => ({
        ok: true,
        data: await context.broker.post(
          'engagement/test-cases/status',
          input,
          engagementMarkTestCaseResultSchema,
        ),
      }),
    }),
    defineTool({
      server: 'engagement',
      name: 'request_scope_exception',
      description:
        'Ask a human to approve a target outside the scope envelope. It opens a Gate 2 decision; nothing is allowed until a ' +
        'different authorised person approves it.',
      inputSchema: engagementScopeExceptionInputSchema,
      outputSchema: engagementScopeExceptionResultSchema,
      readOnly: false,
      handler: async (input, context) => ({
        ok: true,
        data: await context.broker.post(
          'engagement/scope-exceptions',
          input,
          engagementScopeExceptionResultSchema,
        ),
      }),
    }),
  ];
}
