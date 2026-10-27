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
export {
  buildHttpxArgs,
  createHttpxMetrics,
  type HttpEndpointRecord,
  type HttpProbeContext,
  type HttpProbeResult,
  type HttpxMetrics,
  HTTPX_DEFAULTS,
  parseTech,
  probeHttp,
  type RedirectRecord,
  type SkippedTarget,
  spawnHttpx,
  type TechSignal,
} from './recon/httpx.js';
export { isNonPublicIp } from './recon/addresses.js';
export {
  COMMON_PORTS,
  type DiscoverDeps,
  type DiscoverResult,
  type DiscoverServicesInput,
  discoverServices,
  discoverServicesInputSchema,
  discoverServicesOutputSchema,
  type ProbeAuditEvent,
  type ReconBudget,
} from './recon/discover.js';
export {
  createSpawnExecutor,
  type ReconExecutor,
  type ReconRunOptions,
  type ReconTool,
  type SpawnExecutorOptions,
} from './recon/exec.js';
export { createReconMetrics, type ReconMetrics } from './recon/metrics.js';
export {
  type DnsxRecord,
  type NaabuResult,
  type Parsed,
  parseDnsx,
  parseNaabu,
} from './recon/parse.js';
export { createDiscoverServicesTool, type DiscoverServicesSession } from './recon/tool.js';
