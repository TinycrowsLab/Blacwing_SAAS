import { describe, expect, it, vi } from 'vitest';

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

describe('buildRunOptions', () => {
  it('always disallows WebFetch and WebSearch, even when the descriptor omits them', () => {
    const options = buildRunOptions(DESCRIPTOR, new AbortController());
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch']),
    );
    expect(new Set(options.disallowedTools).size).toBe(options.disallowedTools?.length);
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
