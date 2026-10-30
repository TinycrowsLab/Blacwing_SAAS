import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { createToolMetrics } from '../metrics.js';
import { createSessionMetrics } from './metrics.js';
import { createSessionTools } from './tools.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolDefinition, ToolRuntime } from '../tool.js';
import type { z } from 'zod';

const SECRET = 'bwk-secret-cookie-value-do-not-leak';

interface Call {
  readonly method: 'GET' | 'POST' | 'AUDIT';
  readonly path: string;
  readonly body?: unknown;
}

/**
 * A broker that enforces the response schema the way the real client does: a value that does not parse
 * throws, so the tool never returns it. `answers` maps a path to the raw answer.
 */
function brokerWith(answers: Record<string, unknown>): BrokerClient & { calls: Call[] } {
  const calls: Call[] = [];
  const answer = (path: string, schema: z.ZodType | undefined): unknown => {
    const raw = answers[path];
    return schema === undefined ? raw : schema.parse(raw);
  };
  const broker: BrokerClient & { calls: Call[] } = {
    calls,
    get: ((path: string, schema: z.ZodType) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve(answer(path, schema));
    }) as BrokerClient['get'],
    post: ((path: string, body: unknown, schema: z.ZodType) => {
      calls.push({ method: path === 'tool-audit' ? 'AUDIT' : 'POST', path, body });
      return Promise.resolve(answer(path, schema));
    }) as BrokerClient['post'],
  };
  return broker;
}

function runtime(broker: BrokerClient): ToolRuntime {
  return {
    broker,
    evidence: { store: () => Promise.resolve('ev-1') },
    metrics: createToolMetrics(),
    signal: new AbortController().signal,
    subtaskId: null,
    testCaseId: null,
    roleId: 'auth-logic-specialist',
  };
}

function tools(registry = new Registry()): Record<string, ToolDefinition> {
  const defs = createSessionTools(createSessionMetrics(registry));
  return Object.fromEntries(defs.map((definition) => [definition.name, definition]));
}

function envelope(
  result:
    { readonly content: readonly { readonly type: string; readonly text?: unknown }[] } | undefined,
) {
  const first = result?.content[0];
  const text = first?.type === 'text' && typeof first.text === 'string' ? first.text : '{}';
  return JSON.parse(text) as { ok: boolean; code?: string; data?: unknown };
}

/** Broker calls that are domain calls, not the per-call `tool-audit` record. */
const domainCalls = (broker: { calls: Call[] }) => broker.calls.filter((c) => c.method !== 'AUDIT');

describe('session tools (role switching, #696)', () => {
  it('exposes use_role and check_session on the session server under their contract names', () => {
    expect(Object.keys(tools()).sort()).toEqual(['check_session', 'use_role']);
    for (const definition of Object.values(tools())) {
      expect(definition.server).toBe('session');
      expect(definition.qualifiedName).toBe(`mcp__session__${definition.name}`);
    }
    expect(tools().use_role?.readOnly).toBe(false);
    expect(tools().check_session?.readOnly).toBe(true);
  });

  it('switches by role id only: posts the role id and returns the live status', async () => {
    const registry = new Registry();
    const broker = brokerWith({
      'session/roles/use': { roleId: 'user', status: 'live' },
    });
    const result = await tools(registry).use_role?.invoke({ roleId: 'user' }, runtime(broker));
    expect(domainCalls(broker)).toEqual([
      { method: 'POST', path: 'session/roles/use', body: { roleId: 'user' } },
    ]);
    expect(result?.isError).toBe(false);
    expect(envelope(result)).toEqual({ ok: true, data: { roleId: 'user', status: 'live' } });
    expect(await registry.getSingleMetricAsString('authz_role_switches_total')).toContain(
      'outcome="live"} 1',
    );
  });

  it('reports an expired session as an answer the agent can act on, not as an error', async () => {
    const registry = new Registry();
    const broker = brokerWith({
      'session/roles/use': { roleId: 'admin', status: 'expired' },
    });
    const result = await tools(registry).use_role?.invoke({ roleId: 'admin' }, runtime(broker));
    expect(result?.isError).toBe(false);
    expect(envelope(result)).toEqual({ ok: true, data: { roleId: 'admin', status: 'expired' } });
    expect(await registry.getSingleMetricAsString('authz_role_switches_total')).toContain(
      'outcome="expired"} 1',
    );
  });

  it('checks one role session by an encoded status path and never credentials', async () => {
    const registry = new Registry();
    const broker = brokerWith({
      'session/roles/manager_2/status': { roleId: 'manager_2', status: 'unavailable' },
    });
    const result = await tools(registry).check_session?.invoke(
      { roleId: 'manager_2' },
      runtime(broker),
    );
    expect(domainCalls(broker)).toEqual([
      { method: 'GET', path: 'session/roles/manager_2/status' },
    ]);
    expect(envelope(result)).toEqual({
      ok: true,
      data: { roleId: 'manager_2', status: 'unavailable' },
    });
    expect(await registry.getSingleMetricAsString('mcp_session_checks_total')).toContain(
      'outcome="unavailable"} 1',
    );
  });

  it.each([
    ['an uppercase role id', { roleId: 'Admin' }],
    ['a path traversal role id', { roleId: '../admin' }],
    ['an empty role id', { roleId: '' }],
    ['a role id over 63 characters', { roleId: `a${'b'.repeat(63)}` }],
    ['a missing role id', {}],
  ])('refuses %s before any broker call (TOOL_INVALID_INPUT)', async (_label, input) => {
    for (const name of ['use_role', 'check_session'] as const) {
      const broker = brokerWith({});
      const result = await tools()[name]?.invoke(input, runtime(broker));
      expect(envelope(result)).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
      expect(domainCalls(broker)).toEqual([]);
    }
  });

  it('refuses a credential field smuggled into the input (strict input, nothing reaches the broker)', async () => {
    const broker = brokerWith({});
    const result = await tools().use_role?.invoke(
      { roleId: 'user', password: SECRET },
      runtime(broker),
    );
    expect(envelope(result)).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
    expect(JSON.stringify(broker.calls)).not.toContain(SECRET);
    expect(domainCalls(broker)).toEqual([]);
  });

  it('fails closed when the broker answers with a credential-bearing field, and never returns it', async () => {
    const broker = brokerWith({
      'session/roles/use': { roleId: 'user', status: 'live', cookie: SECRET },
    });
    const result = await tools().use_role?.invoke({ roleId: 'user' }, runtime(broker));
    expect(envelope(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('fails closed on an unknown status from the broker', async () => {
    const broker = brokerWith({
      'session/roles/user/status': { roleId: 'user', status: 'maybe' },
    });
    const result = await tools().check_session?.invoke({ roleId: 'user' }, runtime(broker));
    expect(envelope(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
  });

  it('writes a per-call audit record that carries the role id and never a credential', async () => {
    const broker = brokerWith({
      'session/roles/use': { roleId: 'user', status: 'live' },
    });
    await tools().use_role?.invoke({ roleId: 'user' }, runtime(broker));
    const audit = broker.calls.find((c) => c.method === 'AUDIT');
    expect(audit).toBeDefined();
    // roleId is the session's own identity (fixed per session); the requested role is the input summary.
    expect(audit?.body).toMatchObject({
      toolName: 'mcp__session__use_role',
      roleId: 'auth-logic-specialist',
      outcome: 'success',
      inputSummary: '{"roleId":"user"}',
    });
    expect(JSON.stringify(audit?.body)).not.toContain(SECRET);
  });
});
