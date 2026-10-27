# @blackwing/mcp-tools

The framework for Blackwing's in-process MCP tool servers (MCP-001, #666). Individual tools arrive with
MCP-002 to MCP-014; the exposure matrix with MCP-015.

- `defineTool({ server, name, description, inputSchema, outputSchema, readOnly, handler })` wraps the Claude
  Agent SDK `tool()`. The tool surfaces as `mcp__<server>__<name>`; `readOnly` becomes `readOnlyHint`
  (the planner and the PDP rely on it), `openWorld` becomes `openWorldHint`.
- `createServer(server, tools, { runtime, alwaysLoad, timeoutMs })` builds the `createSdkMcpServer` instance for
  one session. `MCP_SERVERS` is the fixed set of server names.
- Handlers return `{ ok: true, data }` or `{ ok: false, code, message }` with a stable code from
  `TOOL_ERROR_CODES`. Throwing a `ToolError` is equivalent; any other throw becomes
  `TOOL_BACKEND_UNAVAILABLE` with a fixed message (no raw error text reaches the model or the audit trail).
- Input is validated with the full Zod object before the handler runs (`TOOL_INVALID_INPUT` names the fields,
  never the values). Output is validated against `outputSchema`, which also strips undeclared fields.
- Output over `BW_TOOL_OUTPUT_MAX_BYTES` (default 131072, see `resolveOutputMaxBytes`) is stored through the
  runtime's `EvidenceSink` and replaced with a head/tail excerpt plus `evidence://<id>`. If the evidence cannot
  be stored the call fails; output is never dropped or returned unbounded.
- Every call posts a `tool.invoked` event to the Run Broker (`POST /internal/broker/runs/{runId}/tool-audit`,
  scope `audit:write`) with the session's subtask, test case and role ids (never taken from tool input),
  duration, output size and a redacted input summary. A call that succeeded but could not be audited is
  reported as `TOOL_BACKEND_UNAVAILABLE`.
- `createBrokerClient` is the only way a tool reaches a backend: run-scoped bearer token, timeout, no
  redirects, fail closed (`TOOL_BACKEND_UNAVAILABLE`), `RUN_NOT_ACTIVE` and the session kill signal map to
  `TOOL_KILLED`.
- Metrics: `mcp_tool_calls_total{server,tool,result}`, `mcp_tool_latency_ms`,
  `mcp_tool_output_truncated_total` (`createToolMetrics`); span `mcp.tool`.

This package runs inside agent sandboxes and may not import server-only packages (`dependency-graph.md`).
