import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';
import { ScopeViolationError } from '@blackwing/errors';

import { createReconMetrics } from './metrics.js';
import { createDiscoverServicesTool, type DiscoverServicesSession } from './tool.js';
import { createToolMetrics } from '../metrics.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolRuntime } from '../tool.js';
import type { ReconExecutor } from './exec.js';

const ASSET = '01890a5d-ac96-774b-bcce-b302099a8002';
const RUN = '01890a5d-ac96-774b-bcce-b302099a8003';
const SESSION = '01890a5d-ac96-774b-bcce-b302099a8004';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';
const TARGET_IP = '203.0.113.7';

const scope = parseScopeRules({
  rules: [{ effect: 'include', cidr: '203.0.113.0/24', ports: [80, 443] }],
});

/** A naabu that finds port 80 open on the target and nothing else. */
const executor: ReconExecutor = {
  run: (tool) =>
    Promise.resolve(
      tool === 'naabu' ? `${JSON.stringify({ ip: TARGET_IP, port: 80, protocol: 'tcp' })}\n` : '',
    ),
};

function session(overrides: Partial<DiscoverServicesSession> = {}): DiscoverServicesSession {
  return {
    executor,
    scope,
    assetId: ASSET,
    budget: { maxRequests: 100, rps: 10, concurrency: 5, maxHosts: 10 },
    toolVersions: { dnsx: '1.2.2', naabu: '2.3.4' },
    provenance: { runId: RUN, sessionId: SESSION, persona: 'active-recon' },
    writeSurface: () => Promise.resolve(undefined),
    metrics: createReconMetrics(new Registry()),
    ...overrides,
  };
}

function runtime(signal = new AbortController().signal): ToolRuntime & {
  posted: { suffix: string; body: Record<string, unknown> }[];
} {
  const posted: { suffix: string; body: Record<string, unknown> }[] = [];
  const broker: BrokerClient = {
    get: () => Promise.reject(new Error('unused')),
    post: ((suffix: string, body: unknown) => {
      posted.push({ suffix, body: body as Record<string, unknown> });
      return Promise.resolve(undefined);
    }) as BrokerClient['post'],
  };
  return {
    broker,
    evidence: { store: () => Promise.resolve('ev-1') },
    metrics: createToolMetrics(),
    signal,
    subtaskId: SUBTASK,
    testCaseId: TEST_CASE,
    roleId: 'active-recon',
    posted,
  };
}

const parse = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

describe('createDiscoverServicesTool', () => {
  it('is an active, non-read-only tool on the target server', () => {
    const tool = createDiscoverServicesTool(session());
    expect(tool.qualifiedName).toBe('mcp__target__discover_services');
    expect(tool.readOnly).toBe(false);
  });

  it('returns the discovered services and posts one tool-audit event per probe batch', async () => {
    const tool = createDiscoverServicesTool(session());
    const rt = runtime();
    const result = await tool.invoke({ hosts: [TARGET_IP], ports: [80] }, rt);

    expect(parse(result)).toMatchObject({
      ok: true,
      data: { services: [{ address: TARGET_IP, port: 80, proto: 'tcp' }] },
    });
    const probes = rt.posted
      .filter((event) => event.suffix === 'tool-audit')
      .map((event) => event.body)
      .filter((body) => body.toolName === 'mcp__target__naabu');
    expect(probes).toEqual([
      expect.objectContaining({
        subtaskId: SUBTASK,
        testCaseId: TEST_CASE,
        roleId: 'active-recon',
        outcome: 'success',
        code: null,
      }),
    ]);
  });

  it('never takes identity from the model input: unknown keys are rejected', async () => {
    const tool = createDiscoverServicesTool(session());
    const result = await tool.invoke(
      { hosts: [TARGET_IP], subtaskId: 'forged', scope: { rules: [] } },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_INVALID_INPUT' });
  });

  it('rejects an empty or malformed host list before any probe', async () => {
    const calls: string[] = [];
    const tool = createDiscoverServicesTool(
      session({
        executor: {
          run: (name) => {
            calls.push(name);
            return Promise.resolve('');
          },
        },
      }),
    );
    expect(parse(await tool.invoke({ hosts: [] }, runtime()))).toMatchObject({
      ok: false,
      code: 'TOOL_INVALID_INPUT',
    });
    expect(parse(await tool.invoke({ hosts: ['not a host!!'] }, runtime()))).toMatchObject({
      ok: false,
      code: 'TOOL_INVALID_INPUT',
    });
    expect(calls).toEqual([]);
  });

  it('maps a surface write rejected for scope to TOOL_SCOPE_DENIED', async () => {
    const tool = createDiscoverServicesTool(
      session({
        writeSurface: () => Promise.reject(new ScopeViolationError('outside the envelope')),
      }),
    );
    const result = await tool.invoke({ hosts: [TARGET_IP], ports: [80] }, runtime());
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_SCOPE_DENIED' });
  });

  it('fails with TOOL_KILLED and probes nothing when the run is already killed', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const tool = createDiscoverServicesTool(
      session({
        executor: {
          run: (name) => {
            calls.push(name);
            return Promise.resolve('');
          },
        },
      }),
    );
    const result = await tool.invoke({ hosts: [TARGET_IP] }, runtime(controller.signal));
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_KILLED' });
    expect(calls).toEqual([]);
  });
});
