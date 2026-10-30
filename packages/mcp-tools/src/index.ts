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
export { EXPOSURE_MATRIX, exposureViolations } from './exposure.js';
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
  egressSpawnOptions,
  PROXYCHAINS_CONFIG,
  type ReconExecutor,
  type ReconRunOptions,
  type ReconTool,
  type ScanTool,
  type SpawnExecutorOptions,
} from './recon/exec.js';
export {
  createReconMetrics,
  createReconRunMetrics,
  type ReconMetrics,
  type ReconRunMetrics,
} from './recon/metrics.js';
export {
  type DnsxRecord,
  type HttpxRecord,
  type NaabuResult,
  type Parsed,
  parseDnsx,
  parseHttpx,
  parseNaabu,
} from './recon/parse.js';
export {
  assertAllowedFlags,
  createRunDnsxTool,
  createRunHttpxTool,
  createRunNaabuTool,
  RECON_FLAG_ALLOWLIST,
  type ReconRunSession,
  runDnsxInputSchema,
  runDnsxOutputSchema,
  runHttpxInputSchema,
  runHttpxOutputSchema,
  runNaabuInputSchema,
  runNaabuOutputSchema,
} from './recon/run-tools.js';
export { createDiscoverServicesTool, type DiscoverServicesSession } from './recon/tool.js';
export { type CandidateMetrics, createCandidateMetrics } from './findings/metrics.js';
export { createEngagementMetrics, type EngagementMetrics } from './engagement/metrics.js';
export { createEngagementTools } from './engagement/tools.js';
export {
  type CaptureSource,
  type GatewayCapture,
  type GatewayPart,
  submitWebApiCandidate,
  type StoredEvidence,
  type WebApiCandidate,
  webApiCandidateSchema,
  type WebApiRejection,
  type WebApiSubmitDeps,
  type WebApiSubmitResult,
  WEB_API_CAPTURE_KINDS,
  type WebApiCaptureKind,
} from './findings/submit.js';
export {
  createSubmitCandidateTool,
  type DeclaredTestCase,
  type SubmitCandidateInput,
  type SubmitCandidateSession,
  submitCandidateInputSchema,
  submitCandidateOutputSchema,
} from './findings/submit-candidate.js';
