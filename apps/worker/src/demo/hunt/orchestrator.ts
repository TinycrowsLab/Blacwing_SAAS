// Runs one hunt: an orchestrator agent delegating to specialist subagents through the Agent SDK, streaming everything
// into run_events. Kill, pause and the duration budget are enforced here; scope and method rules live in http-tool.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { EventLog, newHuntState, type CaseState, type HuntContext, type HuntDeps, type Logger } from './context.js';
import { closePendingAsks, GATE2_POLL_MS, watchGate2 } from './http-tool.js';
import { MessageRouter } from './messages.js';
import { subagents, SUBAGENT_NAMES, systemPrompt } from './prompts.js';
import { createHuntServer } from './tools.js';

import type { HuntRun, HuntStore } from './types.js';

const MS_PER_S = 1000;
const CONTROL_POLL_MS = 500;
const PAUSE_POLL_MS = 500;
/** Hook timeout headroom past the duration budget: the pause gate may hold a tool call that long. */
const HOOK_TIMEOUT_SLACK_S = 60;
const PROGRESS_POLL_MS = 5000;
const MAX_TURNS = 200;
const BUILT_IN_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'BashOutput', 'KillShell'];
const AGENT_LANES = ['orchestrator', ...SUBAGENT_NAMES, 'validator'];
const hookInput = z.object({ tool_name: z.string(), tool_input: z.record(z.string(), z.unknown()), agent_type: z.string().optional() });
const BLACKWING_TOOL = 'mcp__blackwing__';

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

/**
 * PreToolUse for every tool: while the run is paused no agent starts a tool call or a delegation (so no model turn
 * follows either), and every Blackwing tool gets the calling agent stamped into its input, so the model cannot claim
 * to be another agent.
 */
export function toolGate(ctx: HuntContext): HookCallbackMatcher {
  return {
    timeout: ctx.run.budgetSeconds + HOOK_TIMEOUT_SLACK_S,
    hooks: [
      async (input) => {
        while (ctx.state.paused && !ctx.signal.aborted) await ctx.deps.sleep(PAUSE_POLL_MS);
        const parsed = hookInput.safeParse(input);
        if (!parsed.success || !parsed.data.tool_name.startsWith(BLACKWING_TOOL)) return {};
        const agent = parsed.data.agent_type ?? 'orchestrator';
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...parsed.data.tool_input, agent } } };
      },
    ],
  };
}

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
        hooks: { PreToolUse: [toolGate(ctx)] },
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
    state: newHuntState(),
  };
  const finishFailed = async (reason: string): Promise<void> => {
    await emitCoverage(ctx, reason);
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
          await closePendingAsks(ctx, 'killed');
        }
      })
      .catch((error: unknown) => {
        logger.warn({ event: 'demo.hunt.control_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'control poll failed');
      })
      .finally(() => {
        polling = false;
      });
  }, CONTROL_POLL_MS);
  let watching = false;
  const gate2Timer = setInterval(() => {
    if (watching || halted.reason !== null) return;
    watching = true;
    watchGate2(ctx)
      .catch((error: unknown) => {
        logger.warn({ event: 'demo.hunt.gate2_watch_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'gate 2 watch failed');
      })
      .finally(() => {
        watching = false;
      });
  }, GATE2_POLL_MS);
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
    clearInterval(gate2Timer);
    clearInterval(progressTimer);
    clearTimeout(durationTimer);
  }

  const used = { requestsUsed: ctx.state.requestsUsed, costUsd: router.totalCost };
  if (halted.reason === 'killed') {
    await store.saveProgress(run.id, used.requestsUsed, used.costUsd);
    await closePendingAsks(ctx, 'killed');
    const haltMs = await store.markKilled(run);
    await emitCoverage(ctx, 'killed');
    await log.emit('run.killed', 'control', `Run killed. Halt measured in ${haltMs} ms.`, { by: halted.killedBy, haltMs });
    return;
  }
  await closePendingAsks(ctx, 'run_ended');
  const settled = settle(halted.reason, failure, end);
  if (settled.state === 'failed') {
    await finishFailed(settled.reason ?? 'failed');
    return;
  }
  await emitCoverage(ctx, settled.reason ?? (ctx.state.requestsUsed >= run.budgetRequests ? 'request_budget' : null));
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

/** Runner-owned case status: the model's skip, block or decline stands (with its note); otherwise only sent requests or candidates count. */
export function caseOutcome(testCase: CaseState): 'executed' | 'skipped' | 'blocked' | 'model_declined' | 'not_run' {
  if (testCase.status === 'skipped' || testCase.status === 'blocked' || testCase.status === 'model_declined') return testCase.status;
  return testCase.requests > 0 || testCase.candidates > 0 ? 'executed' : 'not_run';
}

/** A case that never ran because a human denied (or did not answer) the request it needed is `blocked`, saying which. */
function caseResult(ctx: HuntContext, id: string, testCase: CaseState): { status: ReturnType<typeof caseOutcome>; note: string | null } {
  const status = caseOutcome(testCase);
  if (status !== 'not_run') return { status, note: testCase.note };
  const refused = [...ctx.state.asks.values()].filter((a) => a.caseId === id && (a.status === 'denied' || a.status === 'expired'));
  if (refused.length === 0) return { status, note: testCase.note };
  return { status: 'blocked', note: refused.map((a) => `Gate 2 ${a.status === 'expired' ? 'got no answer' : 'denied'}: ${a.label}`).join('; ') };
}

/** The `coverage.summary` event data: what was and was not tested, and which test accounts were actually used. */
export function coverageOf(ctx: HuntContext, endReason: string | null): Record<string, unknown> {
  return {
    cases: [...ctx.state.cases].map(([id, c]) => ({ id, title: c.title, agent: c.agent, ...caseResult(ctx, id, c), requests: c.requests, candidates: c.candidates })),
    rolesConfigured: ctx.run.testAccounts.map((a) => a.role),
    rolesUsed: Object.fromEntries(ctx.state.roleCounts),
    requestsSent: ctx.state.requestsUsed,
    endReason,
  };
}

async function emitCoverage(ctx: HuntContext, endReason: string | null): Promise<void> {
  const cases = [...ctx.state.cases].map(([id, c]) => caseResult(ctx, id, c).status);
  const count = (status: string): number => cases.filter((c) => c === status).length;
  const message = cases.length === 0
    ? 'Coverage: no test cases were recorded'
    : `Coverage: ${count('executed')} of ${cases.length} test cases executed, ${count('skipped') + count('blocked')} skipped or blocked, ${count('model_declined')} declined by the model, ${count('not_run')} not run`;
  await ctx.log.emit('coverage.summary', 'done', message, coverageOf(ctx, endReason));
}
