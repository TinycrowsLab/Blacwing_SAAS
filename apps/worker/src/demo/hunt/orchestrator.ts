// Runs one hunt: an orchestrator agent delegating to specialist subagents through the Agent SDK, streaming everything
// into run_events. Kill, pause and the duration budget are enforced here; scope and method rules live in http-tool.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { caseOutcome, EventLog, newHuntState, type CaseState, type Gate2Ask, type HuntContext, type HuntDeps, type Logger } from './context.js';
import { closePendingAsks, GATE2_POLL_MS, sleepUnlessStopped, watchGate2 } from './http-tool.js';
import { MessageRouter } from './messages.js';
import { subagents, SUBAGENT_NAMES, systemPrompt } from './prompts.js';
import { createHuntServer } from './tools.js';

import type { HuntRun, HuntStore } from './types.js';

const MS_PER_S = 1000;
const CONTROL_POLL_MS = 200;
const PAUSE_POLL_MS = 500;
/** Hook timeout headroom past the duration budget: the pause gate may hold a tool call that long. */
const HOOK_TIMEOUT_SLACK_S = 60;
const PROGRESS_POLL_MS = 5000;
const MAX_TURNS = 200;
/** Runner-owned coverage: after the team says it is done, up to this many follow-up rounds run untried cases. */
const MAX_ROUNDS = 3;
/** A follow-up round needs this much of each budget left (requests, time, cost) to be worth starting. */
const MIN_LEFT_FRACTION = 0.1;
const MIN_LEFT_S = 60;
/** The first follow-up widens the plan when the team used less than this share of the request budget. */
const WIDEN_BELOW_FRACTION = 0.25;
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

export { caseOutcome };

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
        while (ctx.state.paused && !ctx.signal.aborted) await sleepUnlessStopped(ctx, PAUSE_POLL_MS);
        const parsed = hookInput.safeParse(input);
        if (!parsed.success || !parsed.data.tool_name.startsWith(BLACKWING_TOOL)) return {};
        const agent = parsed.data.agent_type ?? 'orchestrator';
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...parsed.data.tool_input, agent } } };
      },
    ],
  };
}

/** Streams the agent team's messages until it ends. Returns how the model run ended, or null when it threw or was aborted. */
async function streamAgents(ctx: HuntContext, config: HuntConfig, abort: AbortController, router: MessageRouter, prompt: string): Promise<AgentEnd | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'bw-hunt-'));
  // Each round is its own model session: its cost adds to what the earlier rounds spent.
  const spent = router.totalCost;
  try {
    const conversation = query({
      prompt,
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
        maxBudgetUsd: Math.max(ctx.run.costCapUsd - spent, 0),
        abortController: abort,
        cwd,
        env: config.modelEnv,
      },
    });
    const costTimer = setInterval(() => {
      conversation
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
        .then((usage) => {
          router.setTotalCost(spent + usage.session.total_cost_usd);
        })
        .catch(() => undefined); // the cost keeps its last value; the final result carries the total
    }, PROGRESS_POLL_MS);
    let end: AgentEnd | null = null;
    try {
      for await (const message of conversation) {
        await router.handle(message);
        if (message.type === 'result') {
          router.setTotalCost(spent + message.total_cost_usd);
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
  // A kill ends the run at once: the agent session unwinds in the background (every tool is already refused by the
  // aborted signal), so the measured halt is the time to stop acting, not the time the session takes to tear down.
  let released: () => void = () => undefined;
  const killed = new Promise<null>((resolve) => {
    released = () => {
      resolve(null);
    };
  });
  let polling = false;
  const controlTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    store
      .readControl(run.id)
      .then(async (control) => {
        ctx.state.paused = control.paused;
        if (control.kill !== null && halted.reason === null) {
          logger.info({ event: 'dbg.detected', t: Date.now() }, 'dbg');
          halted.reason = 'killed';
          halted.killedBy = control.kill.by;
          abort.abort();
          released();
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
  const summaries: string[] = [];
  const startedAt = deps.now();
  try {
    await log.emit('run.started', 'plan', `Run started with ${config.model}`, { model: config.model, agents: AGENT_LANES });
    let prompt = 'Begin the assessment now.';
    for (let round = 1; ; round += 1) {
      const session = streamAgents(ctx, config, abort, router, prompt);
      session.catch(() => undefined); // a session abandoned by a kill unwinds on its own
      end = await Promise.race([session, killed]);
      if (end?.summary !== null && end?.summary !== undefined) summaries.push(end.summary);
      if (halted.reason !== null || end?.subtype !== 'success') break;
      const isHalted = (): boolean => halted.reason !== null;
      await holdForAsks(ctx, isHalted);
      if (isHalted()) break;
      const next = nextRound(ctx, { round, spentUsd: router.totalCost, elapsedS: (deps.now() - startedAt) / MS_PER_S });
      if (next === null) break;
      await log.emit('run.continued', 'plan', next.message, { round: round + 1, untried: next.cases, widen: next.widen, approved: next.approved });
      prompt = next.prompt;
    }
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
    logger.info({ event: 'dbg.afterloop', t: Date.now() }, 'dbg');
    await store.saveProgress(run.id, used.requestsUsed, used.costUsd);
    await closePendingAsks(ctx, 'killed');
    logger.info({ event: 'dbg.beforeMark', t: Date.now() }, 'dbg');
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
  await store.finishRun(run, { state: 'completed', ...used, summary: summaries.length === 0 ? null : summaries.join('\n\n') });
}

/**
 * The team said it is done, but an ask still waits for a person: the run stays open until each is decided or reaches
 * its deadline (the duration budget and kill still end it), so an answer given in time is never thrown away.
 */
export async function holdForAsks(ctx: HuntContext, halted: () => boolean): Promise<void> {
  const pending = (): Gate2Ask[] => [...ctx.state.asks.values()].filter((a) => a.status === 'pending');
  if (pending().length === 0) return;
  const count = pending().length;
  await ctx.log.emit('run.holding', 'gate2', `Waiting for your answer on ${count} request${count === 1 ? '' : 's'} before finishing`, { gate2Ids: pending().map((a) => a.id) });
  while (pending().length > 0 && !halted() && !ctx.signal.aborted) {
    await sleepUnlessStopped(ctx, GATE2_POLL_MS);
    await watchGate2(ctx);
  }
}

/**
 * Runner-owned coverage: the model does not decide alone when testing is done. After a round, every case that has not
 * run (including one whose Gate 2 was just approved) goes back to the team, while budget is left; the first follow-up
 * also widens a plan that used little of the request budget. Null when the run should end.
 */
export function nextRound(
  ctx: HuntContext,
  at: { round: number; spentUsd: number; elapsedS: number },
): { prompt: string; message: string; cases: string[]; widen: boolean; approved: number } | null {
  const { run, state } = ctx;
  if (at.round >= MAX_ROUNDS) return null;
  if (run.budgetRequests - state.requestsUsed < run.budgetRequests * MIN_LEFT_FRACTION) return null;
  if (run.costCapUsd - at.spentUsd < run.costCapUsd * MIN_LEFT_FRACTION) return null;
  if (run.budgetSeconds - at.elapsedS < Math.max(MIN_LEFT_S, run.budgetSeconds * MIN_LEFT_FRACTION)) return null;
  const untried = [...state.cases].filter(([id, c]) => caseResult(ctx, id, c).status === 'not_run');
  const approved = [...state.asks.values()].filter((a) => a.status === 'approved' && a.sent !== true);
  const widen = at.round === 1 && state.requestsUsed < run.budgetRequests * WIDEN_BELOW_FRACTION;
  if (untried.length === 0 && approved.length === 0 && !widen) return null;
  const lines = untried.map(([id, c]) => `- ${id} (${c.agent}): ${c.title}${c.target === undefined || c.target === '' ? '' : ` at ${c.target}`}`);
  const asks = approved.map((a) => `- ${a.label}${a.caseId === null ? '' : ` (case ${a.caseId})`}: approved by a person; ${a.agent} should send it now`);
  const prompt = [
    'Follow-up round of the same assessment (Blackwing, not the model, decides when testing is done). Recon has already run: do not delegate to recon again; use list_exchanges to recall what was sent.',
    untried.length === 0 ? '' : `These recorded test cases have not been run yet. Delegate each to its specialist now:\n${lines.join('\n')}`,
    asks.length === 0 ? '' : `These Gate 2 asks were approved after their agent finished. Have that specialist send each request again now:\n${asks.join('\n')}`,
    widen
      ? `The team used ${state.requestsUsed} of ${run.budgetRequests} requests. Review the plan against the classes the objective asks for and the endpoints recon found (every input, form, write endpoint and object id). Record test cases for what is still missing with record_test_cases, then delegate them. If nothing applicable is missing, say so in one line and finish.`
      : '',
    'When the specialists are done, write a short summary of this round (what was tested, what was not covered).',
  ].filter((part) => part !== '').join('\n\n');
  const n = untried.length + approved.length;
  const message = n === 0 ? 'Blackwing asked the team to widen the plan before finishing' : `Blackwing handed ${n} untried item${n === 1 ? '' : 's'} back to the team`;
  return { prompt, message, cases: untried.map(([id]) => id), widen, approved: approved.length };
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

function caseResult(ctx: HuntContext, id: string, testCase: CaseState): { status: ReturnType<typeof caseOutcome>; note: string | null } {
  const status = caseOutcome(testCase);
  const asks = [...ctx.state.asks.values()].filter((a) => a.caseId === id);
  const refused = asks.filter((a) => a.status === 'denied' || a.status === 'expired');
  const said = (a: Gate2Ask): string =>
    a.status === 'expired' ? 'got no answer' : a.closedUnanswered === true ? 'got no answer before the audit ended' : 'denied';
  if (refused.length > 0 && (status === 'not_run' || status === 'blocked')) {
    return { status: 'blocked', note: refused.map((a) => `Gate 2 ${said(a)}: ${a.label}`).join('; ') };
  }
  // The model's own "blocked" note was written while its Gate 2 ask was open; the outcome since is the runner's to state.
  if (status === 'blocked' && asks.length > 0) {
    const approved = asks.filter((a) => a.status === 'approved');
    if (approved.length === asks.length) {
      const unsent = approved.filter((a) => a.sent !== true);
      return unsent.length === 0
        ? { status: 'executed', note: `Approved at Gate 2 and sent: ${approved.map((a) => a.label).join('; ')}` }
        : { status: 'not_run', note: `Approved at Gate 2 but not sent before the audit ended: ${unsent.map((a) => a.label).join('; ')}` };
    }
    return { status, note: `Waiting for a Gate 2 decision: ${asks.filter((a) => a.status === 'pending').map((a) => a.label).join('; ')}` };
  }
  return { status, note: testCase.note };
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
