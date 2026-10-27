import { ScopeViolationError } from '@blackwing/errors';

import {
  type DiscoverDeps,
  discoverServices,
  discoverServicesInputSchema,
  discoverServicesOutputSchema,
  type ProbeAuditEvent,
} from './discover.js';
import { ToolError } from '../errors.js';
import { defineTool, type ToolDefinition, type ToolHandlerContext } from '../tool.js';

/** Everything the session fixes for `discover_services`: scope, budget, asset and sinks are never model input. */
export type DiscoverServicesSession = Omit<DiscoverDeps, 'signal' | 'audit'>;

const auditBody = (
  event: ProbeAuditEvent,
  context: ToolHandlerContext,
): Record<string, unknown> => ({
  toolName: `mcp__target__${event.tool}`,
  subtaskId: context.subtaskId,
  testCaseId: context.testCaseId,
  roleId: context.roleId,
  durationMs: event.durationMs,
  outputBytes: event.outputBytes,
  outcome: event.outcome,
  code: event.code,
  inputSummary: event.inputSummary,
});

/**
 * `mcp__target__discover_services` (RECON-007): active host resolution and in-scope service discovery with
 * `dnsx` and `naabu` (CONNECT mode). Each executed probe batch posts a `tool.invoked` audit event.
 */
export function createDiscoverServicesTool(session: DiscoverServicesSession): ToolDefinition {
  return defineTool({
    server: 'target',
    name: 'discover_services',
    description:
      'Resolve in-scope host names and find their open TCP services (active_safe CONNECT scan through the egress gateway). ' +
      'Only hosts and ports inside the scope envelope are probed; results are written to the surface model.',
    inputSchema: discoverServicesInputSchema,
    outputSchema: discoverServicesOutputSchema,
    readOnly: false,
    openWorld: true,
    handler: async (input, context) => {
      try {
        const data = await discoverServices(
          {
            ...session,
            signal: context.signal,
            audit: (event) => context.broker.post('tool-audit', auditBody(event, context)),
          },
          input,
        );
        return { ok: true, data };
      } catch (error) {
        if (error instanceof ScopeViolationError) {
          throw new ToolError('TOOL_SCOPE_DENIED', 'a surface node is outside the scope envelope');
        }
        throw error;
      }
    },
  });
}
