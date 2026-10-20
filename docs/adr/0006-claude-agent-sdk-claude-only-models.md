# ADR-0006: Run the product's agents on the Claude Agent SDK with Claude models only

Date: 2026-10-20

## Status

Accepted

## Context

Blackwing's agent team (orchestrator, planners, recon, specialists, validator assistant, reporter and others)
needs a mature agent loop: tool use, subagents, hooks around every tool call, structured output, resumable
sessions and telemetry. The original feature list promised "bring your own model" across Azure OpenAI,
Bedrock, GCP and custom endpoints. The SaaS edition instead commits to one agent runtime and one model family,
so that tool-call enforcement, refusal handling and evaluation are built and tested once.

## Decision

- The product's agents run on the **Claude Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`), hosted
  by `apps/agent-runtime` inside each agent sandbox, with Blackwing tools served in-process over MCP. The SDK
  version is pinned exactly and recorded per run.
- **Models are Claude only.** "Bring your own model" becomes **bring your own Claude endpoint**: the
  Blackwing-managed Anthropic API (default), the customer's own Anthropic API key, or the customer's Claude
  deployment on Amazon Bedrock, Google Vertex AI or Microsoft Foundry. Azure OpenAI/GPT and other providers are
  not supported.
- Every model call goes through the **Blackwing model gateway** with a short-lived per-session virtual key. Real
  provider credentials never enter a sandbox, and the gateway enforces that no data goes to another provider.
- Every session is configured restrictively: no inherited settings or host environment, never
  `bypassPermissions`, networked built-in tools (WebFetch, WebSearch) disallowed, and a PDP check in the
  `PreToolUse` hook ([ADR-0007](0007-cedar-policy-decision-point.md)).
- Production runs authenticate with an Anthropic API key or a cloud provider. A Claude.ai subscription login
  never powers customer runs. The product is branded "Blackwing" (optionally "Powered by Claude"), never
  "Claude Code".

## Consequences

- Hooks, structured output and session resume give the deterministic Run Controller the control points it needs
  ([ADR-0005](0005-temporal-run-lifecycle.md)); enforcement never depends on the model's compliance.
- Customers who require a non-Claude model cannot use Blackwing v1; that is a deliberate product boundary.
- Model refusals are an expected outcome (`model_declined`), recorded in the coverage manifest and never
  rephrased or evaded.
- SDK upgrades are explicit, evaluated changes because the version is pinned per run.

## References

- [Context Pack §4 Claude Code as the agent runtime](../architecture/CONTEXT_PACK.md#4-claude-code-as-the-agent-runtime-critical-design),
  in particular [§4.3 Mandatory SDK options](../architecture/CONTEXT_PACK.md#43-mandatory-sdk-options-for-every-blackwing-session-appsagent-runtimesrcsessionoptionsts)
  and [§4.5 Policy and terms constraints](../architecture/CONTEXT_PACK.md#45-policy--terms-constraints-must-follow).
- [Context Pack §1.1 Deliberate overrides](../architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides):
  row F36 "Bring your own model".
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  row "Agents".
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.7 (secrets never reach the model), §8.9 (pinned versions) and §8.11 (no model-dependent safety).
