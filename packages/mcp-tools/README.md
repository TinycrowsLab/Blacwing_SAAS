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

## `mcp__findings__submit_candidate` (MCP-009, #673)

`createSubmitCandidateTool(session)` lets a specialist submit a candidate finding. The session supplies the
persisted test-case record (oracle and negative control declared before the test ran), an evidence check and a
reversal-journal check; none of it is model input. A submission is rejected with `TOOL_INVALID_INPUT` and a
reason (`oracle_not_predeclared`, `missing_negative_control`, `missing_reversal_journal`, `invalid_evidence`,
`wrong_test_case`, `test_case_not_running`) unless the oracle binding equals the declared oracle, the negative
control is declared, a `state_changing` test case has a journal entry and the evidence ids exist. It posts to the
broker `candidates` endpoint with an idempotency key over `(testCaseId, location, oracleBinding)` and can only
return status `candidate`. Metrics: `mcp_candidates_submitted_total{class}`,
`mcp_candidate_rejections_total{reason}` (`createCandidateMetrics`); span `mcp.submit_candidate`.

## `mcp__target__run_httpx`, `run_naabu`, `run_dnsx` (MCP-010, #670)

Typed wrappers around the pinned ProjectDiscovery binaries (`src/recon/run-tools.ts`). The agent supplies only
targets (`targets`, `hosts` plus `ports`, `names`), and every input object is strict, so no flag can come from the
model. Each run checks every target against the scope envelope before the binary starts; one out-of-scope target
denies the whole call (`TOOL_SCOPE_DENIED`). The flag set is fixed per tool and checked against
`RECON_FLAG_ALLOWLIST` (`assertAllowedFlags`). `httpx` is read-only and forced through the gateway with `-proxy`;
`naabu` is an active, in-scope-ports-only TCP connect scan; `dnsx` is read-only. Records are parsed into bounded
JSON (`records` capped at 500, with `total` and `truncated`), raw stdout is stored as evidence, and each run posts a
`tool-audit` event with the flags used and the pinned `toolVersion`. Proxy forcing for proxy-unaware binaries
comes from `egressSpawnOptions` (`proxychains-ng`). Metrics: `mcp_recon_runs_total{tool,result}`,
`mcp_recon_duration_ms{tool}` (`createReconRunMetrics`); span `mcp.recon`.

## Tool-exposure matrix (MCP-015, #680)

`src/exposure.ts` is the single source of which tools each of the 19 personas may call. `EXPOSURE_MATRIX`
maps a persona name to its exact tool row (`mcp__<server>__<tool>` names and built-ins). `@blackwing/agents`
builds every persona's `allowedTools` from its row, so a definition cannot drift from the matrix; CI
(`packages/agents/src/personas/exposure.test.ts`) fails when they differ, and `pnpm gen:persona-catalogue`
plus the drift check fails when the rendered catalogue is stale. A `__*` entry is a prefix wildcard for an
external MCP server (for example `mcp__playwright__*`).

Every entry needs a class in `TOOL_EXPOSURE_CLASSES` (`readOnly`, `reachesTarget`). `exposureViolations(persona, tools)`
is the rule both the tests and the matrix use: an unclassified tool, a networked built-in (`WebFetch`, `WebSearch`),
a target-reaching tool outside the target mandate (`TARGET_MANDATE_PERSONAS`) and a non-read-only tool for a
read-only persona (`READ_ONLY_PERSONAS`) are all violations. Helpers inherit only within their parent's row.

## `mcp__engagement__*`: the orchestrator's engagement tools (MCP-012, #677)

`createEngagementTools(metrics)` returns seven tools of the `engagement` server: `get_engagement_state`,
`list_open_subtasks`, `dispatch_subtask`, `get_subtask_result`, `request_mentor_review`, `mark_test_case_status`
and `request_scope_exception`. Every tool is a call to the Run Broker under `/internal/broker/runs/{runId}/engagement/*`
with the run-scoped token. The broker decides: a dispatch is sent to the Run Controller (`ExecutionWorkflow`,
update `dispatchSubtask`), which starts the specialist as a child workflow in a new sandbox. No tool runs a
specialist in-process, and the native `Agent`/`Task` tool is never used for cross-sandbox dispatch (§4.2).

- Reads (`get_engagement_state`, `list_open_subtasks`, `get_subtask_result`) are `readOnly`. A subtask still in
  flight answers `pending: true`, not an error.
- `dispatch_subtask` takes `persona`, `subtaskId`, `testCaseId` and a self-contained `brief`. Extra fields are
  refused, and the brief is capped at `DISPATCH_BRIEF_MAX_BYTES` (16 KiB). A refusal (`PERSONA_INELIGIBLE`,
  `CONCURRENCY_LIMIT`, ...) is returned as a value so the orchestrator can back off or re-plan.
- `mark_test_case_status` accepts only `executing|executed|skipped|blocked|failed|model_declined|not_applicable`
  with a reason. The broker enforces `TEST_CASE_STATUS_TRANSITIONS` against the stored status; a refused move
  reaches the model as `TOOL_INVALID_INPUT`.
- `request_scope_exception` opens a Gate 2 `scope_exception` decision. Nothing is allowed until a different
  authorised person approves it.

Metrics: `mcp_dispatch_total{outcome}`, `mcp_engagement_reads_total{tool}` (`createEngagementMetrics`).
