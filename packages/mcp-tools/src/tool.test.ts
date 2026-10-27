import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type BrokerClient, createBrokerClient } from './broker-client.js';
import { ToolError, toolFailure } from './errors.js';
import { createToolMetrics } from './metrics.js';
import {
  createServer,
  defineTool,
  type ToolDefinition,
  type ToolRuntime,
  type ToolSpec,
} from './tool.js';

const RUN = '01890a5d-ac96-774b-bcce-b302099a8057';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';

interface Posted {
  suffix: string;
  body: Record<string, unknown>;
}

function fakeBroker(options: { auditFails?: boolean } = {}): BrokerClient & { posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    posted,
    get: () => Promise.reject(new Error('unused')),
    post: ((suffix: string, body: unknown) => {
      if (options.auditFails === true) {
        return Promise.reject(new ToolError('TOOL_BACKEND_UNAVAILABLE', 'down'));
      }
      posted.push({ suffix, body: body as Record<string, unknown> });
      return Promise.resolve(undefined);
    }) as BrokerClient['post'],
  };
}

function runtime(
  overrides: Partial<ToolRuntime> = {},
): ToolRuntime & { broker: ReturnType<typeof fakeBroker> } {
  return {
    broker: fakeBroker(),
    evidence: { store: () => Promise.resolve('ev-1') },
    metrics: createToolMetrics(),
    signal: new AbortController().signal,
    subtaskId: SUBTASK,
    testCaseId: TEST_CASE,
    roleId: 'recon',
    ...overrides,
  } as ToolRuntime & { broker: ReturnType<typeof fakeBroker> };
}

const input = z.strictObject({ id: z.string().min(1) }).refine((v) => v.id !== 'forbidden', {
  message: 'forbidden id',
});

type Spec = ToolSpec<z.ZodObject<{ id: z.ZodString }>, z.ZodObject<{ value: z.ZodString }>>;

/** A tool over `{ id }` that echoes it back; `overrides` replace any part of the spec. */
function echo(overrides: Partial<Record<keyof Spec, unknown>> = {}): ToolDefinition {
  const spec: Spec = {
    server: 'engagement',
    name: 'get_engagement_state',
    description: 'Reads the engagement state.',
    // Carries an object-level refinement on top of the raw shape, as real tools may.
    inputSchema: input,
    outputSchema: z.object({ value: z.string() }),
    readOnly: true,
    handler: (args) => Promise.resolve({ ok: true, data: { value: args.id } }),
  };
  return defineTool({ ...spec, ...overrides } as Spec);
}

const parse = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;

describe('defineTool', () => {
  it('exposes mcp__server__name and readOnlyHint on the SDK tool', () => {
    const readOnly = echo();
    expect(readOnly.qualifiedName).toBe('mcp__engagement__get_engagement_state');
    const sdk = readOnly.bind(runtime()) as unknown as {
      name: string;
      annotations: { readOnlyHint: boolean; openWorldHint: boolean };
    };
    expect(sdk.name).toBe('get_engagement_state');
    expect(sdk.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });

    const mutating = echo({ name: 'dispatch_subtask', readOnly: false, openWorld: true });
    const sdk2 = mutating.bind(runtime()) as unknown as typeof sdk;
    expect(sdk2.annotations).toEqual({ readOnlyHint: false, openWorldHint: true });
  });

  it.each(['Get', 'get', 'get-state', '_get_x', 'get__x', 'get_X'])(
    'rejects the tool name %s',
    (name) => {
      expect(() => echo({ name })).toThrow(TypeError);
    },
  );

  it('rejects an unknown server, a blank description and an over-long qualified name', () => {
    expect(() => echo({ server: 'nope' })).toThrow(TypeError);
    expect(() => echo({ description: ' ' })).toThrow(TypeError);
    expect(() => echo({ name: `get_${'x'.repeat(60)}` })).toThrow(TypeError);
  });

  it('returns ok data as JSON text', async () => {
    const result = await echo().invoke({ id: 'a' }, runtime());
    expect(result.isError).toBe(false);
    expect(parse(result)).toEqual({ ok: true, data: { value: 'a' } });
  });

  it.each([null, undefined, {}, { id: '' }, { id: 1 }, { id: 'a', extra: 1 }, 'str', []])(
    'maps invalid input %j to TOOL_INVALID_INPUT',
    async (raw) => {
      const handler = vi.fn();
      const result = await echo({ handler }).invoke(raw, runtime());
      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('enforces object-level refinements and does not echo input values', async () => {
    const result = await echo().invoke({ id: 'forbidden' }, runtime());
    const body = parse(result);
    expect(body).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
    expect(JSON.stringify(body)).not.toContain('forbidden');
  });

  it('passes a handler failure through with its stable code', async () => {
    const tool = echo({
      handler: () => Promise.resolve(toolFailure('TOOL_BUDGET_EXCEEDED', 'budget spent')),
    });
    expect(parse(await tool.invoke({ id: 'a' }, runtime()))).toEqual({
      ok: false,
      code: 'TOOL_BUDGET_EXCEEDED',
      message: 'budget spent',
    });
  });

  it('maps a thrown ToolError to its code and never throws', async () => {
    const tool = echo({
      handler: () => Promise.reject(new ToolError('TOOL_SCOPE_DENIED', 'no scope')),
    });
    expect(parse(await tool.invoke({ id: 'a' }, runtime()))).toMatchObject({
      code: 'TOOL_SCOPE_DENIED',
    });
  });

  it('maps a raw throw to TOOL_BACKEND_UNAVAILABLE without leaking its message', async () => {
    const tool = echo({
      handler: () => {
        throw new Error('ECONNREFUSED 10.0.0.5 token=bwrun_abc');
      },
    });
    const result = await tool.invoke({ id: 'a' }, runtime());
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('bwrun_abc');
  });

  it('rejects a handler result that breaks the output schema', async () => {
    const tool = echo({
      handler: () => Promise.resolve({ ok: true, data: { value: 1 } }),
    });
    expect(parse(await tool.invoke({ id: 'a' }, runtime()))).toMatchObject({
      code: 'TOOL_BACKEND_UNAVAILABLE',
    });
  });

  it('strips fields the output schema does not declare', async () => {
    const tool = echo({
      handler: () => Promise.resolve({ ok: true, data: { value: 'v', leak: 'secret' } }),
    });
    expect(parse(await tool.invoke({ id: 'a' }, runtime())).data).toEqual({ value: 'v' });
  });
});

describe('output size limit', () => {
  it('replaces oversized output with an evidence pointer and keeps Unicode intact', async () => {
    const stored: string[] = [];
    const big = `日本語-${'😀'.repeat(40_000)}-終`;
    const tool = echo({
      handler: () => Promise.resolve({ ok: true, data: { value: big } }),
    });
    const rt = runtime({
      maxOutputBytes: 131_072,
      evidence: {
        store: (e: { content: string }) => {
          stored.push(e.content);
          return Promise.resolve('ev-77');
        },
      },
    });
    const result = await tool.invoke({ id: 'a' }, rt);
    const body = parse(result) as {
      ok: boolean;
      truncated: boolean;
      evidence: string;
      head: string;
      tail: string;
    };
    expect(result.isError).toBe(false);
    expect(body).toMatchObject({ ok: true, truncated: true, evidence: 'evidence://ev-77' });
    expect(body.head).toContain('日本語-');
    expect(body.tail).toContain('-終');
    expect(`${body.head}${body.tail}`).not.toContain('�');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0] ?? '')).toEqual({ ok: true, data: { value: big } });
    expect(
      Buffer.byteLength(
        result.content[0] && 'text' in result.content[0] ? result.content[0].text : '',
      ),
    ).toBeLessThan(131_072);
    const metrics = await rt.metrics.registry.metrics();
    expect(metrics).toContain(
      'mcp_tool_output_truncated_total{server="engagement",tool="get_engagement_state"} 1',
    );
    expect(rt.broker.posted[0]?.body.outputBytes).toBeGreaterThan(131_072);
  });

  it('fails closed when the evidence sink is down', async () => {
    const tool = echo({
      handler: () => Promise.resolve({ ok: true, data: { value: 'x'.repeat(5000) } }),
    });
    const rt = runtime({
      maxOutputBytes: 1024,
      evidence: { store: () => Promise.reject(new Error('down')) },
    });
    const result = await tool.invoke({ id: 'a' }, rt);
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
    expect(rt.broker.posted[0]?.body).toMatchObject({
      outcome: 'error',
      code: 'TOOL_BACKEND_UNAVAILABLE',
    });
  });
});

describe('kill', () => {
  it('refuses a call made after the kill without running the handler', async () => {
    const handler = vi.fn();
    const result = await echo({ handler }).invoke(
      { id: 'a' },
      runtime({ signal: AbortSignal.abort() }),
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_KILLED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers TOOL_KILLED when the kill lands mid-call, even if the handler later succeeds', async () => {
    const controller = new AbortController();
    const tool = echo({
      handler: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, data: { value: 'applied' } });
          }, 50);
        }),
    });
    const pending = tool.invoke({ id: 'a' }, runtime({ signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 10);
    const result = await pending;
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_KILLED' });
  });

  it('answers TOOL_KILLED when the handler returns after an abort it observed', async () => {
    const controller = new AbortController();
    const tool = echo({
      handler: () => {
        controller.abort();
        return Promise.resolve({ ok: true, data: { value: 'applied' } });
      },
    });
    expect(
      parse(await tool.invoke({ id: 'a' }, runtime({ signal: controller.signal }))),
    ).toMatchObject({
      code: 'TOOL_KILLED',
    });
  });
});

describe('per-call audit', () => {
  it('emits tool.invoked with ids, duration, size and a redacted summary', async () => {
    const rt = runtime();
    await echo().invoke({ id: 'AKIAABCDEFGHIJKLMNOP' }, rt);
    expect(rt.broker.posted).toHaveLength(1);
    const { suffix, body } = rt.broker.posted[0] ?? { suffix: '', body: {} };
    expect(suffix).toBe('tool-audit');
    expect(body).toMatchObject({
      toolName: 'mcp__engagement__get_engagement_state',
      subtaskId: SUBTASK,
      testCaseId: TEST_CASE,
      roleId: 'recon',
      outcome: 'success',
      code: null,
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.outputBytes).toBeGreaterThan(0);
    expect(String(body.inputSummary)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('audits failures and invalid input too, with the error code', async () => {
    const rt = runtime();
    await echo().invoke(null, rt);
    expect(rt.broker.posted[0]?.body).toMatchObject({
      outcome: 'error',
      code: 'TOOL_INVALID_INPUT',
    });
  });

  it('takes ids from the session, never from tool input', async () => {
    const rt = runtime();
    await echo().invoke({ id: 'a', subtaskId: 'forged', roleId: 'admin' }, rt);
    expect(rt.broker.posted[0]?.body).toMatchObject({ subtaskId: SUBTASK, roleId: 'recon' });
  });

  it('audits each of several concurrent calls independently', async () => {
    const rt = runtime();
    const tool = echo();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => tool.invoke({ id }, rt)));
    expect(rt.broker.posted).toHaveLength(4);
    const metrics = await rt.metrics.registry.metrics();
    expect(metrics).toContain(
      'mcp_tool_calls_total{server="engagement",tool="get_engagement_state",result="ok"} 4',
    );
  });

  it('fails a successful call that could not be audited (no audit, no success)', async () => {
    const result = await echo().invoke(
      { id: 'a' },
      runtime({ broker: fakeBroker({ auditFails: true }) }),
    );
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
  });

  it('keeps the original error code when an error call cannot be audited', async () => {
    const result = await echo({
      handler: () => Promise.resolve(toolFailure('TOOL_SCOPE_DENIED', 'no')),
    }).invoke({ id: 'a' }, runtime({ broker: fakeBroker({ auditFails: true }) }));
    expect(parse(result)).toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
  });

  it('applies the injected registry redactor to the summary', async () => {
    const rt = runtime({ redact: (text: string) => text.replaceAll('hunter2', '[registry]') });
    await echo().invoke({ id: 'hunter2' }, rt);
    expect(String(rt.broker.posted[0]?.body.inputSummary)).toContain('[registry]');
  });
});

describe('broker failures', () => {
  it('turns an unreachable broker into TOOL_BACKEND_UNAVAILABLE, never a silent success', async () => {
    const dead = createBrokerClient({
      baseUrl: 'http://127.0.0.1:1',
      runId: RUN,
      token: 'bwrun_x',
      timeoutMs: 500,
    });
    const tool = echo({
      handler: async (_args: unknown, ctx: { broker: BrokerClient }) => {
        await ctx.broker.get('state', z.unknown());
        return { ok: true, data: { value: 'x' } };
      },
    });
    const result = await tool.invoke({ id: 'a' }, runtime({ broker: dead }));
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
  });
});

describe('createServer', () => {
  it('builds an in-process SDK server with its tools', () => {
    const server = createServer('engagement', [echo()], {
      runtime: runtime(),
      alwaysLoad: true,
      timeoutMs: 5000,
    });
    expect(server).toMatchObject({ type: 'sdk', name: 'engagement' });
  });

  it('rejects a tool of another server and duplicate names', () => {
    const other = echo({ server: 'target' });
    expect(() => createServer('engagement', [other], { runtime: runtime() })).toThrow(TypeError);
    expect(() => createServer('engagement', [echo(), echo()], { runtime: runtime() })).toThrow(
      TypeError,
    );
  });
});
