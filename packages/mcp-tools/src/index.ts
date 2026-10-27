/** Workspace package name of this package. */
export const name = '@blackwing/mcp-tools';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type BrokerClient,
  type BrokerClientOptions,
  createBrokerClient,
} from './broker-client.js';
export {
  TOOL_ERROR_CODES,
  ToolError,
  type ToolErrorCode,
  type ToolFailure,
  type ToolResult,
  toolFailure,
} from './errors.js';
export { DEFAULT_TOOL_OUTPUT_MAX_BYTES, resolveOutputMaxBytes } from './limits.js';
export { createToolMetrics, type ToolMetrics } from './metrics.js';
export {
  type CreateServerOptions,
  createServer,
  defineTool,
  MCP_SERVERS,
  type McpServerName,
  type ToolDefinition,
  type ToolHandlerContext,
  type ToolRuntime,
  type ToolSpec,
} from './tool.js';
export { type EvidenceSink } from './truncate.js';
