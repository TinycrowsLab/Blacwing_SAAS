// Runs one hunt: an orchestrator agent delegating to specialist subagents through the Agent SDK, streaming everything
// into run_events. Kill, pause and the duration budget are enforced here; scope and method rules live in http-tool.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { EventLog, type HuntContext, type HuntDeps, type Logger } from './context.js';
import { MessageRouter } from './messages.js';
import { subagents, SUBAGENT_NAMES, systemPrompt } from './prompts.js';
import { createHuntServer } from './tools.js';

import type { HuntRun, HuntStore } from './types.js';

const MS_PER_S = 1000;
const CONTROL_POLL_MS = 500;
const PROGRESS_POLL_MS = 5000;
const MAX_TURNS = 200;
const BUILT_IN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'BashOutput', 'KillShell'];
const AGENT_LANES = ['orchestrator', ...SUBAGENT_NAMES, 'validator'];
const hookInput = z.object({ tool_input: z.record(z.string(), z.unknown()), agent_type: z.string().optional() });

export interface HuntConfig {
  readonly model: string;
  /** Environment for the model process: HOME, PATH and ANTHROPIC_* only. */
  readonly modelEnv: Record<string, string>;
  /** The host Claude login may power a run only in the local dev environment. */
  readonly allowHostLogin: boolean;
}

export type HaltReason = 'killed' | 'duration_budget';

export interface AgentEnd {
  readonly subtype: string;
  readonly summary: string | null;
}

/** Stamps the calling agent into the tool input, so the model cannot claim to be another agent. */
const stampAgent: HookCallbackMatcher = {
  matcher: 'mcp__blackwing__(http_request|submit_candidate|record_test_cases|update_test_case)',
  hooks: [
    (input) => {
      const parsed = hookInput.safeParse(input);
      if (!parsed.success) return Promise.resolve({});
      const agent = parsed.data.agent_type ?? 'orchestrator';
      return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...parsed.data.tool_input, agent } } });
    },
  ],
};

/** Streams the agent team's messages until it ends. Returns how the model run ended, or null when it threw or was aborted. */
async function streamAgents(ctx: HuntContext, config: HuntConfig, abort: AbortController, router: MessageRouter): Promise<AgentEnd | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'bw-hunt-'));
  try {
    const conversation = query({
      prompt: 'Begin the assessment now.',
      options: {
        model: config.model,
        systemPrompt: systemPrompt(ctx.run),
        agents: subagents(ctx.run),
        mcpServers: { blackwing: createHuntServer(ctx) },
        tools: ['Agent', 'TodoWrite'],
        allowedTools: ['Agent', 'TodoWrite', 'mcp__blackwing__*'],
        disallowedTools: BUILT_IN_TOOLS,
        permissionMode: 'dontAsk',
        hooks: { PreToolUse: [stampAgent] },
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: MAX_TURNS,
        maxBudgetUsd: ctx.run.costCapUsd,
        abortController: abort,
        cwd,
        env: config.modelEnv,
      },
    });
    const costTimer = setInterval(() => {
      conversation
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
        .then((usage) => {
          router.setTotalCost(usage.session.total_cost_usd);
        })
        .catch(() => undefined); // the cost keeps its last value; the final result carries the total
    }, PROGRESS_POLL_MS);
    let end: AgentEnd | null = null;
    try {
      for await (const message of conversation) {
        await router.handle(message);
        if (message.type === 'result') {
          router.setTotalCost(message.total_cost_usd);
          end = { subtype: message.subtype, summary: message.subtype === 'success' ? message.result : null };
        }
      }
    } finally {
      clearInterval(costTimer);
    }
    return end;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Executes one claimed run end to end and records its terminal state. Never throws: a failure becomes a failed
 * run with a `run.failed` event.
 */
export async function executeRun(store: HuntStore, run: HuntRun, deps: HuntDeps, config: HuntConfig, logger: Logger): Promise<void> {
  const log = new EventLog(store, run.id, logger);
  const router = new MessageRouter(log);
  const abort = new AbortController();
  const ctx: HuntContext = {
    run,
    store,
    log,
    signal: abort.signal,
    deps,
    state: { requestsUsed: 0, exchangeSeq: 0, paused: false, findings: 0, approved: new Set(), cases: new Map() },
  };
  const finishFailed = async (reason: string): Promise<void> => {
    await log.emit('run.failed', 'done', `Run failed: ${reason}`, { requestsUsed: ctx.state.requestsUsed, costUsd: router.totalCost, findings: ctx.state.findings, reason });
    await store.finishRun(run, { state: 'failed', requestsUsed: ctx.state.requestsUsed, costUsd: router.totalCost, summary: null });
  };

  if (config.modelEnv.ANTHROPIC_API_KEY === undefined && !config.allowHostLogin) {
    await finishFailed('model_credentials_missing');
    return;
  }

  const halted: { reason: HaltReason | null; killedBy: string | null } = { reason: null, killedBy: null };
  let polling = false;
  const controlTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    store
      .readControl(run.id)
      .then(async (control) => {
        ctx.state.paused = control.paused;
        if (control.kill !== null && halted.reason === null) {
          halted.reason = 'killed';
          halted.killedBy = control.kill.by;
          abort.abort();
          await store.denyPendingGate2(run.id);
        }
      })
      .catch((error: unknown) => {
        logger.warn({ event: 'demo.hunt.control_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'control poll failed');
      })
      .finally(() => {
        polling = false;
      });
  }, CONTROL_POLL_MS);
  const progressTimer = setInterval(() => {
    store.saveProgress(run.id, ctx.state.requestsUsed, router.totalCost).catch(() => undefined);
  }, PROGRESS_POLL_MS);
  const durationTimer = setTimeout(() => {
    halted.reason ??= 'duration_budget';
    abort.abort();
  }, run.budgetSeconds * MS_PER_S);

  let end: AgentEnd | null = null;
  let failure: string | null = null;
  try {
    await log.emit('run.started', 'plan', `Run started with ${config.model}`, { model: config.model, agents: AGENT_LANES });
    end = await streamAgents(ctx, config, abort, router);
  } catch (error) {
    failure = error instanceof Error ? error.name : 'model_error';
    logger.error({ event: 'demo.hunt.agent_failed', runId: run.id, reason: failure }, 'agent run failed');
  } finally {
    clearInterval(controlTimer);
    clearInterval(progressTimer);
    clearTimeout(durationTimer);
  }

  const used = { requestsUsed: ctx.state.requestsUsed, costUsd: router.totalCost };
  if (halted.reason === 'killed') {
    await store.saveProgress(run.id, used.requestsUsed, used.costUsd);
    await store.denyPendingGate2(run.id);
    const haltMs = await store.markKilled(run);
    await log.emit('run.killed', 'control', `Run killed. Halt measured in ${haltMs} ms.`, { by: halted.killedBy, haltMs });
    return;
  }
  const settled = settle(halted.reason, failure, end);
  if (settled.state === 'failed') {
    await finishFailed(settled.reason ?? 'failed');
    return;
  }
  await log.emit('run.completed', 'done', 'Run completed', { ...used, findings: ctx.state.findings, ...(settled.reason === null ? {} : { reason: settled.reason }) });
  await store.finishRun(run, { state: 'completed', ...used, summary: end?.summary ?? null });
}

/** Decides how a run that was not killed ended. */
export function settle(halt: HaltReason | null, failure: string | null, end: AgentEnd | null): { state: 'completed' | 'failed'; reason: string | null } {
  if (halt === 'duration_budget') return { state: 'completed', reason: 'duration_budget' };
  if (failure !== null) return { state: 'failed', reason: failure };
  if (end === null) return { state: 'failed', reason: 'no_result' };
  switch (end.subtype) {
    case 'success':
      return { state: 'completed', reason: null };
    case 'error_max_budget_usd':
      return { state: 'completed', reason: 'cost_cap' };
    case 'error_max_turns':
      return { state: 'completed', reason: 'max_turns' };
    default:
      return { state: 'failed', reason: end.subtype };
  }
}
