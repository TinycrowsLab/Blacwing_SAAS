import { InMemorySessionStore, type HookInput, type Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_RECORD_SUFFIX, type AgentSessionDescriptor } from '@blackwing/contracts';

import { parseSessionDescriptor } from '../descriptor.js';
import { createRuntimeMetrics, type RuntimeMetrics } from '../metrics.js';
import { createSessionResumer, RESUME_PROMPT, type ResumeDeferredInput } from './resume.js';
import {
  type RunQuery,
  type SessionLog,
  type SessionStreamMessage,
  runSession,
} from './run-session.js';

import type { BrokerClient } from '@blackwing/mcp-tools';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SHA = 'c'.repeat(64);
const TOKEN = 'bwrun_c2VjcmV0LXRva2VuLXZhbHVl.c2lnbmF0dXJl';
const SIGNAL = new AbortController().signal;

const DESCRIPTOR: AgentSessionDescriptor = parseSessionDescriptor(
  JSON.stringify({
    runId: RUN,
    sessionId: SESSION,
    tenantId: TENANT,
    persona: 'web-api-specialist',
    personaVersion: '1.2.0',
    promptSha256: SHA,
    model: 'claude-opus-5-5',
    effort: 'high',
    maxTurns: 40,
    maxBudgetUsd: 2.5,
    allowedTools: ['Read', 'mcp__http__*'],
    disallowedTools: ['Bash'],
    brief: 'Probe the login form.',
    envelopeHash: SHA,
    brokerBaseUrl: 'http://127.0.0.1:8080',
    brokerToken: TOKEN,
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk-run-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir: '/workspace/a',
  }),
);

/** The deferred call Gate 2 decided: a state-changing-free curl to an in-scope target, as the hook extracted it. */
const DEFERRED = {
  toolUseId: 'toolu_1',
  toolName: 'Bash',
  targets: ['https://lab.example.test/'],
} as const;
const CALL = {
  tool_name: 'Bash',
  tool_input: { command: 'curl https://lab.example.test/' },
  tool_use_id: 'toolu_1',
};

const input = (over: Partial<ResumeDeferredInput> = {}): ResumeDeferredInput => ({
  descriptor: DESCRIPTOR,
  exceptionId: '01920000-0000-7000-8000-00000000000a',
  call: DEFERRED,
  decision: 'approve_once',
  journalMissing: false,
  ...over,
});

/** A broker that reports the run active and answers each brokered POST from `answers` (default: success). */
function broker(
  options: { active?: boolean; getFails?: boolean; answers?: Record<string, unknown> } = {},
) {
  const posts: { suffix: string; body: unknown }[] = [];
  const client: BrokerClient = {
    get: vi.fn(() => {
      if (options.getFails === true) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve({
        runId: RUN,
        state: 'executing',
        active: options.active ?? true,
        observedAt: '2026-10-29T10:00:00.000Z',
      });
    }) as BrokerClient['get'],
    post: vi.fn((suffix: string, body: unknown) => {
      posts.push({ suffix, body });
      return Promise.resolve(options.answers?.[suffix]);
    }) as BrokerClient['post'],
  };
  return { client, posts };
}

const PDP_EXCEPTION = {
  decision: 'exception',
  reason: 'out_of_scope',
  intrusiveness: 'active_safe',
};
const GATE2_APPROVED_ONCE = { exceptionId: SESSION, state: 'approved_once' };

function fakeLog(): SessionLog & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (fields, message) => lines.push(`${message} ${JSON.stringify(fields)}`) };
}

/**
 * A `RunQuery` that runs `script` against the SDK options it was started with, then yields a success result. The
 * script plays the model: it calls the tool through the hook the options carry.
 */
function scriptedQuery(script: (options: Options) => Promise<void> = () => Promise.resolve()): {
  readonly runQuery: RunQuery;
  readonly starts: Options[];
} {
  const starts: Options[] = [];
  const runQuery: RunQuery = ({ options }) => {
    starts.push(options);
    return (async function* (): AsyncGenerator<SessionStreamMessage> {
      await script(options);
      yield {
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        total_cost_usd: 0.2,
        modelUsage: {},
        permission_denials: [],
      };
    })();
  };
  return { runQuery, starts };
}

/** Calls the resumed session's PreToolUse hook for `call` and returns the decision and its reason. */
async function callHook(
  options: Options,
  call: { tool_name: string; tool_input: unknown; tool_use_id: string },
): Promise<readonly [string, string]> {
  const callback = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (callback === undefined) throw new Error('PreToolUse hook must be registered');
  const hookInput = {
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    ...call,
  } as unknown as HookInput;
  const out = (await callback(hookInput, call.tool_use_id, { signal: SIGNAL })) as unknown as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  return [
    out.hookSpecificOutput.permissionDecision,
    out.hookSpecificOutput.permissionDecisionReason,
  ];
}

function metricsOf(metrics: RuntimeMetrics): Promise<string> {
  return metrics.registry.metrics();
}

describe('session resume (GATE2-007)', () => {
  it('resumes from the stored session and runs the approved call exactly once', async () => {
    const { client, posts } = broker({
      answers: { 'pdp/evaluate': PDP_EXCEPTION, 'gate2/exceptions': GATE2_APPROVED_ONCE },
    });
    const store = new InMemorySessionStore();
    const metrics = createRuntimeMetrics();
    const decisions: (readonly [string, string])[] = [];
    const query = scriptedQuery(async (options) => {
      decisions.push(await callHook(options, CALL));
      // A second equivalent call is a new out-of-envelope call: it re-enters the gate and is not allowed.
      decisions.push(await callHook(options, { ...CALL }));
    });
    const resumer = createSessionResumer({
      broker: client,
      runQuery: query.runQuery,
      sessionStore: store,
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics,
    });

    const outcome = await resumer.resume(input());

    expect(outcome).toEqual({
      outcome: 'resumed',
      status: 'success',
      numTurns: 3,
      totalCostUsd: 0.2,
    });
    expect(query.starts).toHaveLength(1);
    expect(query.starts[0]).toMatchObject({ resume: SESSION, sessionId: SESSION });
    expect(query.starts[0]?.sessionStore).toBe(store);
    expect(decisions).toEqual([
      ['allow', 'gate2_approved_once'],
      ['deny', 'gate2_resume_required'],
    ]);
    expect(posts.map((p) => p.suffix)).toEqual([
      'pdp/evaluate',
      'gate2/exceptions',
      AGENT_SESSION_RECORD_SUFFIX,
    ]);
    expect(await metricsOf(metrics)).toContain(
      'gate2_resumes_total{decision="approve_once",outcome="resumed"} 1',
    );
  });

  it('starts the resumed query with the continuation prompt, not the original brief', async () => {
    const query = scriptedQuery();
    const { client } = broker();
    const prompts: string[] = [];
    const runQuery: RunQuery = (request) => {
      prompts.push(request.prompt);
      return query.runQuery(request);
    };
    await createSessionResumer({
      broker: client,
      runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    }).resume(input());
    expect(prompts).toEqual([RESUME_PROMPT]);
  });

  it('denies the deferred call with its reason when the human denied it, and records the outcome', async () => {
    const { client, posts } = broker();
    const decisions: (readonly [string, string])[] = [];
    const query = scriptedQuery(async (options) => {
      decisions.push(await callHook(options, CALL));
    });
    const outcome = await createSessionResumer({
      broker: client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    }).resume(input({ decision: 'deny' }));

    expect(outcome.outcome).toBe('resumed');
    expect(decisions).toEqual([['deny', 'gate2_denied']]);
    expect(posts.map((p) => p.suffix)).toEqual([AGENT_SESSION_RECORD_SUFFIX]);
  });

  it('denies an approved state-changing call with no reversal-journal entry, regardless of approval (§8.3)', async () => {
    const { client } = broker();
    const decisions: (readonly [string, string])[] = [];
    const query = scriptedQuery(async (options) => {
      decisions.push(await callHook(options, CALL));
    });
    await createSessionResumer({
      broker: client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    }).resume(input({ journalMissing: true }));

    expect(decisions).toEqual([['deny', 'state_change_without_journal']]);
  });

  it('does not resume a run that is no longer active, and never starts the session', async () => {
    const { client } = broker({ active: false });
    const query = scriptedQuery();
    const metrics = createRuntimeMetrics();
    const outcome = await createSessionResumer({
      broker: client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics,
    }).resume(input());

    expect(outcome).toEqual({ outcome: 'run_inactive' });
    expect(query.starts).toHaveLength(0);
    expect(await metricsOf(metrics)).toContain(
      'gate2_resumes_total{decision="approve_once",outcome="run_inactive"} 1',
    );
  });

  it('reports session_expired and counts a failure when the session cannot be resumed, without recording it', async () => {
    const { client, posts } = broker();
    const metrics = createRuntimeMetrics();
    const failing: RunQuery = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('No conversation found with session id')),
      }),
    });
    const outcome = await createSessionResumer({
      broker: client,
      runQuery: failing,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics,
    }).resume(input());

    expect(outcome).toEqual({ outcome: 'session_expired' });
    expect(posts).toEqual([]);
    const text = await metricsOf(metrics);
    expect(text).toContain('gate2_resume_failures_total 1');
    expect(text).toContain(
      'gate2_resumes_total{decision="approve_once",outcome="session_expired"} 1',
    );
  });

  it('applies a repeated resume of the same decision once: the second answers duplicate and runs nothing', async () => {
    const { client } = broker({
      answers: { 'pdp/evaluate': PDP_EXCEPTION, 'gate2/exceptions': GATE2_APPROVED_ONCE },
    });
    const query = scriptedQuery();
    const resumer = createSessionResumer({
      broker: client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    });
    expect((await resumer.resume(input())).outcome).toBe('resumed');
    expect(await resumer.resume(input())).toEqual({ outcome: 'duplicate' });
    expect(query.starts).toHaveLength(1);
  });

  it('releases the decision when the broker cannot answer, so the retry can still resume', async () => {
    const query = scriptedQuery();
    const flaky = broker({ getFails: true });
    const resumer = createSessionResumer({
      broker: flaky.client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    });
    await expect(resumer.resume(input())).rejects.toThrow('ECONNREFUSED');
    expect(query.starts).toHaveLength(0);

    const healthy = broker();
    const retry = createSessionResumer({
      broker: healthy.client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    });
    expect((await retry.resume(input())).outcome).toBe('resumed');
  });

  it('resumes after a simulated pod loss: the new process reads the transcript the first one mirrored', async () => {
    const store = new InMemorySessionStore();
    const first = scriptedQuery((options) => {
      // The first process ran the session; the SDK mirrored its transcript into the shared store.
      expect(options.sessionStore).toBe(store);
      return store.append({ projectKey: 'run', sessionId: SESSION }, [
        { type: 'user', uuid: 'u1' },
      ]);
    });
    const { client } = broker();
    await runSession(DESCRIPTOR, {
      broker: client,
      runQuery: first.runQuery,
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
      sessionStore: store,
    });
    expect(store.size).toBe(1);

    // The process is gone. A new process (fresh metrics, fresh resumer) rehydrates from the same store.
    const second = scriptedQuery((options) => {
      if (options.resume !== undefined && store.size === 0) {
        return Promise.reject(new Error('no transcript'));
      }
      return Promise.resolve();
    });
    const outcome = await createSessionResumer({
      broker: broker({
        answers: { 'pdp/evaluate': PDP_EXCEPTION, 'gate2/exceptions': GATE2_APPROVED_ONCE },
      }).client,
      runQuery: second.runQuery,
      sessionStore: store,
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    }).resume(input());
    expect(outcome.outcome).toBe('resumed');
    expect(second.starts[0]?.resume).toBe(SESSION);
  });

  it('reports session_expired when the replacement process has no transcript to resume from', async () => {
    const query = scriptedQuery((options) => {
      if (options.resume !== undefined) return Promise.reject(new Error('no transcript'));
      return Promise.resolve();
    });
    const outcome = await createSessionResumer({
      broker: broker().client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log: fakeLog(),
      metrics: createRuntimeMetrics(),
    }).resume(input());
    expect(outcome).toEqual({ outcome: 'session_expired' });
  });

  it('logs the resume with ids and the outcome, never the call targets or input', async () => {
    const log = fakeLog();
    const query = scriptedQuery();
    await createSessionResumer({
      broker: broker().client,
      runQuery: query.runQuery,
      sessionStore: new InMemorySessionStore(),
      sdkVersion: '0.3.308',
      log,
      metrics: createRuntimeMetrics(),
    }).resume(input());
    const line = log.lines.find((l) => l.startsWith('gate2.resume '));
    expect(line).toBeDefined();
    expect(line).toContain(`"sessionId":"${SESSION}"`);
    expect(line).toContain('"outcome":"resumed"');
    expect(line).not.toContain('lab.example.test');
  });
});
