import { type Mock, describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_RECORD_SUFFIX, type AgentSessionDescriptor } from '@blackwing/contracts';

import { parseSessionDescriptor } from '../descriptor.js';
import { createRuntimeMetrics } from '../metrics.js';
import {
  buildRunOptions,
  EXIT_CODES,
  type RunQuery,
  type SessionLog,
  type SessionStreamMessage,
  runSession,
  SessionExit,
} from './run-session.js';

import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import type { BrokerClient } from '@blackwing/mcp-tools';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SHA = 'c'.repeat(64);
const TOKEN = 'bwrun_c2VjcmV0LXRva2VuLXZhbHVl.c2lnbmF0dXJl';

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
    brief: 'Probe the login form. Ünïcode ✓',
    envelopeHash: SHA,
    brokerBaseUrl: 'http://127.0.0.1:8080',
    brokerToken: TOKEN,
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk-run-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir: '/workspace/a',
  }),
);

interface FakeBroker extends BrokerClient {
  readonly gets: string[];
  readonly posts: { suffix: string; body: unknown }[];
}

function fakeBroker(
  options: { active?: boolean; getFails?: boolean; postFails?: boolean } = {},
): FakeBroker {
  const gets: string[] = [];
  const posts: { suffix: string; body: unknown }[] = [];
  return {
    gets,
    posts,
    get: vi.fn((suffix: string) => {
      gets.push(suffix);
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
      if (options.postFails === true) return Promise.reject(new Error('503'));
      return Promise.resolve(undefined);
    }) as BrokerClient['post'],
  };
}

function fakeLog(): SessionLog & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (fields, message) => lines.push(`${message} ${JSON.stringify(fields)}`),
  };
}

/** An async iterable whose first step rejects with `error`, like an SDK stream that fails at start. */
function failingStream(error: Error): AsyncIterable<never> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
}

/** An async iterable that ends without yielding a message. */
function emptyStream(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

async function* resultStream(
  messages: SessionStreamMessage[] = [],
): AsyncGenerator<SessionStreamMessage> {
  await Promise.resolve();
  for (const message of messages) yield message;
  yield {
    type: 'result',
    subtype: 'success',
    num_turns: 4,
    total_cost_usd: 0.42,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100 } },
  };
}

/** A `RunQuery` that records each start and then yields the given messages (a success result by default). */
function resultQuery(messages: SessionStreamMessage[] = []): RunQuery & { starts: number } {
  const runQuery: RunQuery & { starts: number } = Object.assign(
    () => {
      runQuery.starts += 1;
      return resultStream(messages);
    },
    { starts: 0 },
  );
  return runQuery;
}

describe('runSession', () => {
  it('records exactly one agent session through the broker and resolves with the summary', async () => {
    const broker = fakeBroker();
    const runQuery = resultQuery();
    const log = fakeLog();

    const summary = await runSession(DESCRIPTOR, {
      broker,
      runQuery,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log,
    });

    expect(summary).toEqual({
      sessionId: SESSION,
      status: 'success',
      numTurns: 4,
      totalCostUsd: 0.42,
    });
    expect(broker.gets).toEqual(['state']);
    expect(broker.posts).toHaveLength(1);
    expect(broker.posts[0]).toEqual({
      suffix: AGENT_SESSION_RECORD_SUFFIX,
      body: {
        sessionId: SESSION,
        persona: 'web-api-specialist',
        personaVersion: '1.2.0',
        promptSha256: SHA,
        model: 'claude-opus-5-5',
        effort: 'high',
        sdkVersion: '0.3.308',
        status: 'success',
        numTurns: 4,
        totalCostUsd: 0.42,
        modelUsage: { 'claude-opus-5-5': { inputTokens: 100 } },
      },
    });
    expect(runQuery.starts).toBe(1);
  });

  it('logs the start and the record with ids only, never the token or the brief', async () => {
    const log = fakeLog();
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: resultQuery(),
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log,
    });
    const logged = log.lines.join('\n');
    expect(logged).toContain('session.start_requested');
    expect(logged).toContain(SESSION);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('Probe the login form');
  });

  it('exits 3 and emits no model traffic when the broker is unreachable', async () => {
    const runQuery = resultQuery();
    const error = await runSession(DESCRIPTOR, {
      broker: fakeBroker({ getFails: true }),
      runQuery,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionExit);
    expect((error as SessionExit).exitCode).toBe(EXIT_CODES.brokerUnavailable);
    expect(runQuery.starts).toBe(0);
  });

  it('fails closed with exit 3 when the run is no longer active', async () => {
    const runQuery = resultQuery();
    const error = await runSession(DESCRIPTOR, {
      broker: fakeBroker({ active: false }),
      runQuery,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    }).catch((caught: unknown) => caught);

    expect((error as SessionExit).exitCode).toBe(EXIT_CODES.brokerUnavailable);
    expect(runQuery.starts).toBe(0);
  });

  it('exits 3 when the session finished but the record could not be written', async () => {
    const error = await runSession(DESCRIPTOR, {
      broker: fakeBroker({ postFails: true }),
      runQuery: resultQuery(),
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    }).catch((caught: unknown) => caught);

    expect((error as SessionExit).exitCode).toBe(EXIT_CODES.brokerUnavailable);
  });

  it('exits 4 when the session query throws, and records nothing', async () => {
    const broker = fakeBroker();
    const failing: RunQuery = () => failingStream(new Error('sdk crashed with secret sk-live-123'));

    const error = await runSession(DESCRIPTOR, {
      broker,
      runQuery: failing,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    }).catch((caught: unknown) => caught);

    expect((error as SessionExit).exitCode).toBe(EXIT_CODES.unhandledError);
    expect((error as SessionExit).message).not.toContain('sk-live-123');
    expect(broker.posts).toHaveLength(0);
  });

  it('exits 4 when the session ends without a result message', async () => {
    const silent: RunQuery = () => emptyStream();
    const error = await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: silent,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    }).catch((caught: unknown) => caught);
    expect((error as SessionExit).exitCode).toBe(EXIT_CODES.unhandledError);
  });

  it('uses the last result message, which carries the running totals', async () => {
    const broker = fakeBroker();
    const multi: RunQuery = () =>
      (async function* () {
        await Promise.resolve();
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          num_turns: 1,
          total_cost_usd: 0.1,
          modelUsage: {},
        };
        yield {
          type: 'result',
          subtype: 'success',
          num_turns: 9,
          total_cost_usd: 0.9,
          modelUsage: {},
        };
      })();
    const summary = await runSession(DESCRIPTOR, {
      broker,
      runQuery: multi,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    expect(summary.numTurns).toBe(9);
    expect(broker.posts[0]?.body).toMatchObject({ status: 'success', numTurns: 9 });
  });

  it('counts each started session by persona, and no session refused before the model call', async () => {
    const metrics = createRuntimeMetrics();
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: resultQuery(),
      sdkVersion: '0.3.308',
      metrics,
      log: fakeLog(),
    });
    const line = 'agent_runtime_sessions_started_total{persona="web-api-specialist"} 1';
    expect(await metrics.registry.metrics()).toContain(line);

    await expect(
      runSession(DESCRIPTOR, {
        broker: fakeBroker({ active: false }),
        runQuery: resultQuery(),
        sdkVersion: '0.3.308',
        metrics,
        log: fakeLog(),
      }),
    ).rejects.toBeInstanceOf(SessionExit);
    expect(await metrics.registry.metrics()).toContain(line);
  });
});

/** A `RunQuery` whose result reports the given SDK permission denials, as the real SDK does for denied calls. */
function denialQuery(tools: readonly string[]): RunQuery {
  return () =>
    (async function* denials(): AsyncGenerator<SessionStreamMessage> {
      await Promise.resolve();
      yield {
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        total_cost_usd: 0.1,
        modelUsage: {},
        permission_denials: tools.map((tool_name) => ({ tool_name })),
      };
    })();
}

describe('runSession: denied tool calls (RUNTIME-003)', () => {
  it('counts each SDK-reported denial by persona, tool and reason, and logs its name', async () => {
    const metrics = createRuntimeMetrics();
    const log = fakeLog();
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: denialQuery(['WebFetch', 'Bash', 'mcp__shell__run']),
      sdkVersion: '0.3.308',
      metrics,
      log,
    });
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'agent_tool_denied_total{persona="web-api-specialist",tool="WebFetch",reason="always_disallowed"} 1',
    );
    expect(text).toContain(
      'agent_tool_denied_total{persona="web-api-specialist",tool="Bash",reason="disallowed"} 1',
    );
    expect(text).toContain(
      'agent_tool_denied_total{persona="web-api-specialist",tool="other",reason="not_declared"} 1',
    );
    const denialLines = log.lines.filter((line) => line.startsWith('tool.denied '));
    expect(denialLines).toHaveLength(3);
    expect(denialLines.join('\n')).toContain('"tool":"mcp__shell__run"');
  });

  it('keeps a model-chosen tool name out of the metric labels', async () => {
    const metrics = createRuntimeMetrics();
    const invented = `mcp__http__${'x'.repeat(40)}`;
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: denialQuery([invented]),
      sdkVersion: '0.3.308',
      metrics,
      log: fakeLog(),
    });
    expect(await metrics.registry.metrics()).not.toContain(invented);
  });

  it('records no denial metric when the session reports none', async () => {
    const metrics = createRuntimeMetrics();
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery: resultQuery(),
      sdkVersion: '0.3.308',
      metrics,
      log: fakeLog(),
    });
    expect(await metrics.registry.metrics()).not.toContain('agent_tool_denied_total{');
  });

  it('starts no model call when the descriptor allows a networked built-in', async () => {
    const forbidden: AgentSessionDescriptor = { ...DESCRIPTOR, allowedTools: ['WebSearch'] };
    const runQuery = resultQuery();
    await expect(
      runSession(forbidden, {
        broker: fakeBroker(),
        runQuery,
        sdkVersion: '0.3.308',
        metrics: createRuntimeMetrics(),
        log: fakeLog(),
      }),
    ).rejects.toBeInstanceOf(SessionExit);
    expect(runQuery.starts).toBe(0);
  });
});

describe('buildRunOptions', () => {
  it('always disallows WebFetch and WebSearch, even when the descriptor omits them', () => {
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch']),
    );
    expect(new Set(options.disallowedTools).size).toBe(options.disallowedTools?.length);
  });

  it('also disallows WebRequest, the third networked built-in', () => {
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    expect(options.disallowedTools).toContain('WebRequest');
  });

  it('keeps the permission mode default, reads no sandbox settings, and never bypasses', () => {
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe('/workspace/a');
    expect(options.model).toBe('claude-opus-5-5');
    expect(options.maxTurns).toBe(40);
    expect(options.maxBudgetUsd).toBe(2.5);
  });

  it('wires a deny-by-default permission gate', async () => {
    const signal = new AbortController().signal;
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    const decide = options.canUseTool;
    if (!decide) throw new Error('canUseTool must be set');
    const context = { signal, toolUseID: 'tu-1', requestId: 'rq-1' };
    expect((await decide('mcp__shell__run', {}, context))?.behavior).toBe('deny');
    expect((await decide('Bash', {}, context))?.behavior).toBe('deny');
    expect((await decide('Read', { path: '/workspace/a' }, context))?.behavior).toBe('allow');
  });
});

describe('runSession: PreToolUse hook (RUNTIME-005)', () => {
  const SIGNAL = new AbortController().signal;
  const bashCall = (command: string): HookInput =>
    ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_1',
      session_id: SESSION,
    }) as unknown as HookInput;

  /** Captures the SDK options a session is started with, and yields a success result. */
  function capturingQuery(): { readonly runQuery: RunQuery; readonly seen: Options[] } {
    const seen: Options[] = [];
    const runQuery: RunQuery = ({ options }) => {
      seen.push(options);
      return resultStream();
    };
    return { runQuery, seen };
  }

  /** A broker whose PDP answers `pdp`, and whose other posts succeed. */
  function pdpBroker(pdp: () => Promise<unknown>): { broker: BrokerClient; post: Mock } {
    const get = vi.fn(() =>
      Promise.resolve({
        runId: RUN,
        state: 'executing',
        active: true,
        observedAt: '2026-10-29T10:00:00.000Z',
      }),
    );
    const post = vi.fn((suffix: string) =>
      suffix === 'pdp/evaluate' ? pdp() : Promise.resolve(undefined),
    );
    return {
      broker: { get: get as BrokerClient['get'], post: post as BrokerClient['post'] },
      post,
    };
  }

  async function runWithHook(
    broker: BrokerClient,
  ): Promise<{ readonly hook: (input: HookInput) => Promise<unknown> }> {
    const { runQuery, seen } = capturingQuery();
    await runSession(DESCRIPTOR, {
      broker,
      runQuery,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    const matcher = seen[0]?.hooks?.PreToolUse?.[0];
    const callback = matcher?.hooks[0];
    if (callback === undefined) throw new Error('PreToolUse hook must be registered');
    return { hook: (input) => callback(input, 'toolu_1', { signal: SIGNAL }) };
  }

  it('registers one PreToolUse hook on the SDK options', async () => {
    const { runQuery, seen } = capturingQuery();
    await runSession(DESCRIPTOR, {
      broker: fakeBroker(),
      runQuery,
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    expect(seen[0]?.hooks?.PreToolUse).toHaveLength(1);
  });

  it('returns the PDP allow for a call the PDP accepts, asking the broker for it', async () => {
    const { broker, post } = pdpBroker(() =>
      Promise.resolve({ decision: 'allow', reason: 'in_envelope' }),
    );
    const { hook } = await runWithHook(broker);
    const out = await hook(bashCall('curl https://lab.example.test/'));
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'in_envelope' },
    });
    expect(post).toHaveBeenCalledWith('pdp/evaluate', expect.anything(), expect.anything());
  });

  it('denies a call with the PDP reason when the PDP denies it', async () => {
    const { broker } = pdpBroker(() =>
      Promise.resolve({ decision: 'deny', reason: 'out_of_scope' }),
    );
    const { hook } = await runWithHook(broker);
    const out = await hook(bashCall('curl https://other.example.test/'));
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'out_of_scope' },
    });
  });

  it('fails closed with pdp_unavailable when the PDP call errors, never allow', async () => {
    const { broker } = pdpBroker(() => Promise.reject(new Error('503')));
    const { hook } = await runWithHook(broker);
    const out = await hook(bashCall('ls'));
    expect(out).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'pdp_unavailable',
      },
    });
  });
});

describe('runSession: tool_deferred (RUNTIME-006)', () => {
  /** A session that the PreToolUse hook ended by deferring one call to Gate 2. */
  function deferredQuery(): RunQuery {
    return () =>
      (async function* () {
        await Promise.resolve();
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'tool_deferred',
          deferred_tool_use: { id: 'toolu_9', name: 'Bash', input: { command: 'curl x' } },
          num_turns: 2,
          total_cost_usd: 0.1,
          modelUsage: {},
        } as SessionStreamMessage;
      })();
  }

  it('ends with stop_reason tool_deferred and persists the pending deferred_tool_use', async () => {
    const broker = fakeBroker();
    const summary = await runSession(DESCRIPTOR, {
      broker,
      runQuery: deferredQuery(),
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    expect(summary.status).toBe('tool_deferred');
    expect(broker.posts).toHaveLength(1);
    expect(broker.posts[0]?.suffix).toBe(AGENT_SESSION_RECORD_SUFFIX);
    expect(broker.posts[0]?.body).toMatchObject({
      sessionId: SESSION,
      status: 'tool_deferred',
      deferredToolUse: { toolUseId: 'toolu_9', toolName: 'Bash' },
    });
  });

  it('never persists the deferred call input, which can carry secrets', async () => {
    const broker = fakeBroker();
    await runSession(DESCRIPTOR, {
      broker,
      runQuery: deferredQuery(),
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    expect(JSON.stringify(broker.posts)).not.toContain('curl x');
  });

  it('records a session without a deferred call as its SDK subtype, with no deferred field', async () => {
    const broker = fakeBroker();
    await runSession(DESCRIPTOR, {
      broker,
      runQuery: resultQuery(),
      sdkVersion: '0.3.308',
      metrics: createRuntimeMetrics(),
      log: fakeLog(),
    });
    const body = broker.posts[0]?.body as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body).not.toHaveProperty('deferredToolUse');
  });
});

describe('buildRunOptions hooks (RUNTIME-005)', () => {
  it('adds no hooks key when no hooks are given', () => {
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    expect(options).not.toHaveProperty('hooks');
  });

  it('passes the given hooks through unchanged', () => {
    const hooks = { PreToolUse: [{ hooks: [] }] };
    expect(buildRunOptions(DESCRIPTOR, new AbortController(), hooks).hooks).toBe(hooks);
  });
});
