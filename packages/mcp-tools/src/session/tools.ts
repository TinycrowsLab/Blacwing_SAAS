import {
  checkSessionInputSchema,
  roleSessionResultSchema,
  useRoleInputSchema,
} from '@blackwing/contracts';

import { defineTool, type ToolDefinition } from '../tool.js';

import type { SessionMetrics } from './metrics.js';

/**
 * The role-switching tools of the `session` server (AUTHLOGIC persona, #696; CONTEXT_PACK §4.6, §8.7).
 *
 * A specialist switches between injected role sessions by reference. Both tools are thin calls to the Run
 * Broker with the run-scoped token: the broker (and the egress gateway behind it) owns which session is live and
 * never returns a credential. Each answer is a role id and a status. An expired session is an answer, not an
 * error, so the agent can refresh it and retry the cell; it never switches to an unverified role.
 */
export function createSessionTools(metrics: SessionMetrics): readonly ToolDefinition[] {
  return [
    defineTool({
      server: 'session',
      name: 'use_role',
      description:
        'Switch the active comparison to one role session by its role id. Returns the role id and its status: ' +
        'live means the switch happened; expired means refresh or re-login before retrying. Never pass a credential.',
      inputSchema: useRoleInputSchema,
      outputSchema: roleSessionResultSchema,
      readOnly: false,
      handler: async (input, context) => {
        const result = await context.broker.post(
          'session/roles/use',
          input,
          roleSessionResultSchema,
        );
        metrics.roleSwitches.inc({ outcome: result.status });
        return { ok: true, data: result };
      },
    }),
    defineTool({
      server: 'session',
      name: 'check_session',
      description:
        'Check whether one role session is live before relying on it. Returns the role id and its status, never a credential.',
      inputSchema: checkSessionInputSchema,
      outputSchema: roleSessionResultSchema,
      readOnly: true,
      handler: async (input, context) => {
        const result = await context.broker.get(
          `session/roles/${encodeURIComponent(input.roleId)}/status`,
          roleSessionResultSchema,
        );
        metrics.sessionChecks.inc({ outcome: result.status });
        return { ok: true, data: result };
      },
    }),
  ];
}
