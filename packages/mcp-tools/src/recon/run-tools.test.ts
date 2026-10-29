import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';

import { ToolError } from '../errors.js';
import { createToolMetrics } from '../metrics.js';
import { createReconRunMetrics } from './metrics.js';
import {
  assertAllowedFlags,
  createRunDnsxTool,
  createRunHttpxTool,
  createRunNaabuTool,
  type ReconRunSession,
  runDnsxInputSchema,
  runHttpxInputSchema,
  runNaabuInputSchema,
} from './run-tools.js';

import type { BrokerClient } from '../broker-client.js';
import type { ToolRuntime } from '../tool.js';
import type { ReconExecutor, ReconRunOptions, ReconTool } from './exec.js';

const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';
const TEST_CASE = '01890a5d-ac96-774b-bcce-b302099a8059';
const TARGET_IP = '203.0.113.7';

const scope = parseScopeRules({
  rules: [
    { effect: 'include', host: '*.lab.example' },
    { effect: 'include', cidr: '203.0.113.0/24', ports: [80, 443] },
  ],
});

const VERSIONS = { httpx: '1.6.9', naabu: '2.3.4', dnsx: '1.2.2' } as const;

interface Call {
  readonly tool: ReconTool;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A fake binary set: `stdout` answers per tool; every call is recorded (nothing reaches a network). */
function fakeExecutor(
  stdout: Partial<Record<ReconTool, string>> = {},
  failing?: ReconTool,
): { executor: ReconExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const executor: ReconExecutor = {
    run: (tool: ReconTool, args: readonly string[], options: ReconRunOptions) => {
      calls.push({ tool, args: [...args], stdin: options.stdin });
      if (tool === failing) {
        return Promise.reject(new ToolError('TOOL_BACKEND_UNAVAILABLE', `${tool} failed`));
      }
      return Promise.resolve(stdout[tool] ?? '');
    },
  };
  return { executor, calls };
}

function session(
  executor: ReconExecutor,
  overrides: Partial<ReconRunSession> = {},
): ReconRunSession & { stored: string[] } {
  const stored: string[] = [];
  return {
    executor,
    scope,
    toolVersions: VERSIONS,
    evidence: {
      store: ({ content }) => {
        stored.push(content);
        return Promise.resolve(`ev-${String(stored.length)}`);
      },
    },
    metrics: createReconRunMetrics(new Registry()),
    proxyUrl: 'http://egress.internal:3128',
    rps: 10,
    concurrency: 5,
    stored,
    ...overrides,
  };
}

function runtime(signal = new AbortController().signal): ToolRuntime & {
  posted: Record<string, unknown>[];
} {
  const posted: Record<string, unknown>[] = [];
  const broker: BrokerClient = {
    get: () => Promise.reject(new Error('unused')),
    post: ((suffix: string, body: unknown) => {
      if (suffix === 'tool-audit') posted.push(body as Record<string, unknown>);
      return Promise.resolve(undefined);
    }) as BrokerClient['post'],
  };
  return {
    broker,
    evidence: { store: () => Promise.resolve('ev-tool') },
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

const line = (row: Record<string, unknown>): string => JSON.stringify(row);

/** The wrapper's own audit event (it carries the flag set); the generic tool audit has no `flags`. */
const wrapperAudits = (ctx: { posted: Record<string, unknown>[] }): Record<string, unknown>[] =>
  ctx.posted.filter((event) => 'flags' in event);

describe('input schemas', () => {
  it('rejects any key beyond the declared inputs, so no flag can come from the model', () => {
    expect(
      runHttpxInputSchema.safeParse({ targets: ['https://a.lab.example'], flags: ['-sS'] }),
    ).toMatchObject({ success: false });
    expect(
      runNaabuInputSchema.safeParse({ hosts: [TARGET_IP], ports: [80], args: ['-o'] }),
    ).toMatchObject({ success: false });
    expect(runDnsxInputSchema.safeParse({ names: ['a.lab.example'], '-exec': 'x' })).toMatchObject({
      success: false,
    });
  });

  it('bounds targets, ports and names, and rejects malformed values', () => {
    expect(runHttpxInputSchema.safeParse({ targets: [] }).success).toBe(false);
    expect(runHttpxInputSchema.safeParse({ targets: ['ftp://a.lab.example'] }).success).toBe(false);
    expect(runHttpxInputSchema.safeParse({ targets: ['data:text/html,x'] }).success).toBe(false);
    expect(
      runHttpxInputSchema.safeParse({
        targets: new Array<string>(101).fill('https://a.lab.example'),
      }).success,
    ).toBe(false);
    expect(runNaabuInputSchema.safeParse({ hosts: [TARGET_IP], ports: [0] }).success).toBe(false);
    expect(runNaabuInputSchema.safeParse({ hosts: [TARGET_IP], ports: [65536] }).success).toBe(
      false,
    );
    expect(runNaabuInputSchema.safeParse({ hosts: [TARGET_IP], ports: [80.5] }).success).toBe(
      false,
    );
    expect(runNaabuInputSchema.safeParse({ hosts: ['app.lab.example'], ports: [80] }).success).toBe(
      false,
    );
    expect(runDnsxInputSchema.safeParse({ names: ['not a name'] }).success).toBe(false);
    expect(runDnsxInputSchema.safeParse({ names: ['app.lab.example'] }).success).toBe(true);
  });
});

describe('flag allowlist', () => {
  it('rejects destructive or unreviewed flags for every tool', () => {
    expect(() => {
      assertAllowedFlags('naabu', ['-sS']);
    }).toThrow(TypeError);
    expect(() => {
      assertAllowedFlags('httpx', ['-exec', 'rm']);
    }).toThrow(/not allowlisted/);
    expect(() => {
      assertAllowedFlags('dnsx', ['-o', '/tmp/x']);
    }).toThrow(TypeError);
    expect(() => {
      assertAllowedFlags('httpx', ['-include-response-header']);
    }).toThrow(TypeError);
  });

  it('accepts the flags each wrapper builds', async () => {
    const { executor, calls } = fakeExecutor({
      httpx: line({ url: 'https://app.lab.example', status_code: 200 }),
      naabu: line({ ip: TARGET_IP, port: 80 }),
      dnsx: line({ host: 'app.lab.example', a: [TARGET_IP] }),
    });
    const s = session(executor);
    const ctx = runtime();
    await createRunHttpxTool(s).invoke({ targets: ['https://app.lab.example'] }, ctx);
    await createRunNaabuTool(s).invoke({ hosts: [TARGET_IP], ports: [80] }, ctx);
    await createRunDnsxTool(s).invoke({ names: ['app.lab.example'] }, ctx);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(() => {
        assertAllowedFlags(call.tool, call.args);
      }).not.toThrow();
    }
  });
});

describe('createRunHttpxTool', () => {
  it('is a read-only tool on the target server and pins the proxy in its flags', () => {
    const tool = createRunHttpxTool(session(fakeExecutor().executor));
    expect(tool.qualifiedName).toBe('mcp__target__run_httpx');
    expect(tool.readOnly).toBe(true);
  });

  it('returns parsed status, title, server and technology, with the pinned version and flags', async () => {
    const { executor, calls } = fakeExecutor({
      httpx: [
        line({
          url: 'https://app.lab.example',
          status_code: 200,
          title: 'Login',
          webserver: 'nginx/1.18.0',
          tech: ['Nginx:1.18.0'],
        }),
        line({ url: 'http://app.lab.example/x', failed: true }),
        'not json',
      ].join('\n'),
    });
    const s = session(executor);
    const result = await createRunHttpxTool(s).invoke(
      { targets: ['https://app.lab.example'] },
      runtime(),
    );
    expect(result.isError).toBe(false);
    const data = parse(result).data as Record<string, unknown>;
    expect(data.toolVersion).toBe('1.6.9');
    // The `failed` row and the non-JSON line both count as not parseable into a record.
    expect(data.malformed).toBe(2);
    expect(data.records).toEqual([
      {
        url: 'https://app.lab.example',
        status: 200,
        title: 'Login',
        webserver: 'nginx/1.18.0',
        tech: ['Nginx:1.18.0'],
      },
    ]);
    const args = calls[0]?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(['-proxy', 'http://egress.internal:3128']));
    expect(args).not.toContain('-include-response-header');
    expect(calls[0]?.stdin).toBe('https://app.lab.example\n');
    expect(s.stored).toHaveLength(1);
  });

  it('denies the whole call when any target is outside the scope and never starts httpx', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createRunHttpxTool(session(executor)).invoke(
      { targets: ['https://app.lab.example', 'https://evil.example'] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_SCOPE_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('denies a port the scope does not allow', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createRunHttpxTool(session(executor)).invoke(
      { targets: ['http://203.0.113.7:8080/'] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('turns a non-zero exit into a parsed error and still audits the run', async () => {
    const { executor } = fakeExecutor({}, 'httpx');
    const ctx = runtime();
    const result = await createRunHttpxTool(session(executor)).invoke(
      { targets: ['https://app.lab.example'] },
      ctx,
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
    expect(wrapperAudits(ctx)).toEqual([
      expect.objectContaining({
        toolName: 'mcp__target__run_httpx',
        outcome: 'error',
        code: 'TOOL_BACKEND_UNAVAILABLE',
        toolVersion: '1.6.9',
        flags: expect.arrayContaining(['-proxy']) as unknown,
      }),
    ]);
  });

  it('caps the inline records and keeps the raw output as evidence', async () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      line({ url: `https://h${String(i)}.lab.example`, status_code: 200 }),
    );
    const { executor } = fakeExecutor({ httpx: rows.join('\n') });
    const result = await createRunHttpxTool(session(executor)).invoke(
      { targets: ['https://h0.lab.example'] },
      runtime(),
    );
    const data = parse(result).data as Record<string, unknown>;
    expect(data.total).toBe(600);
    expect(data.truncated).toBe(true);
    expect(data.records as unknown[]).toHaveLength(500);
  });

  it('fails with TOOL_KILLED when the run is killed before it starts', async () => {
    const { executor, calls } = fakeExecutor();
    const controller = new AbortController();
    controller.abort();
    const result = await createRunHttpxTool(session(executor)).invoke(
      { targets: ['https://app.lab.example'] },
      runtime(controller.signal),
    );
    expect(parse(result)).toMatchObject({ code: 'TOOL_KILLED' });
    expect(calls).toHaveLength(0);
  });

  it('fails when the evidence store is down, rather than returning unrecorded output', async () => {
    const { executor } = fakeExecutor({ httpx: line({ url: 'https://app.lab.example' }) });
    const s = session(executor, {
      evidence: { store: () => Promise.reject(new Error('down')) },
    });
    const result = await createRunHttpxTool(s).invoke(
      { targets: ['https://app.lab.example'] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_BACKEND_UNAVAILABLE' });
  });
});

describe('createRunNaabuTool', () => {
  it('is an active, non-read-only tool that only ever sees in-scope ports', () => {
    const tool = createRunNaabuTool(session(fakeExecutor().executor));
    expect(tool.qualifiedName).toBe('mcp__target__run_naabu');
    expect(tool.readOnly).toBe(false);
  });

  it('scans only the requested ports and returns open services', async () => {
    const { executor, calls } = fakeExecutor({
      naabu: [
        line({ ip: TARGET_IP, port: 80, protocol: 'tcp' }),
        line({ ip: TARGET_IP, port: 443 }),
      ].join('\n'),
    });
    const result = await createRunNaabuTool(session(executor)).invoke(
      { hosts: [TARGET_IP], ports: [443, 80, 80] },
      runtime(),
    );
    const data = parse(result).data as Record<string, unknown>;
    expect(data.records).toEqual([
      { host: TARGET_IP, port: 80, proto: 'tcp', state: 'open' },
      { host: TARGET_IP, port: 443, proto: 'tcp', state: 'open' },
    ]);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['-p', '80,443', '-scan-type', 'c', '-Pn']),
    );
    expect(calls[0]?.stdin).toBe(`${TARGET_IP}\n`);
  });

  it('denies the whole call when one port is outside the scope', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createRunNaabuTool(session(executor)).invoke(
      { hosts: [TARGET_IP], ports: [80, 8080] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ ok: false, code: 'TOOL_SCOPE_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('denies an out-of-scope address and never scans it', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createRunNaabuTool(session(executor)).invoke(
      { hosts: ['198.51.100.9'], ports: [80] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('drops results for unrequested ports, unrequested hosts and out-of-scope sightings', async () => {
    const { executor } = fakeExecutor({
      naabu: [
        line({ ip: TARGET_IP, port: 22 }),
        line({ ip: '203.0.113.8', port: 80 }),
        line({ ip: TARGET_IP, port: 80 }),
      ].join('\n'),
    });
    const result = await createRunNaabuTool(session(executor)).invoke(
      { hosts: [TARGET_IP], ports: [80] },
      runtime(),
    );
    const data = parse(result).data as Record<string, unknown>;
    expect(data.records).toEqual([{ host: TARGET_IP, port: 80, proto: 'tcp', state: 'open' }]);
    expect(data.dropped).toBe(2);
  });

  it('is killed mid-run with TOOL_KILLED and audits it', async () => {
    const controller = new AbortController();
    const executor: ReconExecutor = {
      run: () => {
        controller.abort();
        return Promise.reject(new ToolError('TOOL_KILLED', 'the run was killed'));
      },
    };
    const ctx = runtime(controller.signal);
    const result = await createRunNaabuTool(session(executor)).invoke(
      { hosts: [TARGET_IP], ports: [80] },
      ctx,
    );
    expect(parse(result)).toMatchObject({ code: 'TOOL_KILLED' });
    expect(wrapperAudits(ctx)[0]).toMatchObject({ outcome: 'error', code: 'TOOL_KILLED' });
  });
});

describe('createRunDnsxTool', () => {
  it('is read-only and returns the resolved addresses of the asked names only', async () => {
    const { executor, calls } = fakeExecutor({
      dnsx: [
        line({ host: 'app.lab.example', a: [TARGET_IP], aaaa: ['2001:db8::7'] }),
        line({ host: 'other.lab.example', a: ['198.51.100.2'] }),
      ].join('\n'),
    });
    const tool = createRunDnsxTool(session(executor));
    expect(tool.readOnly).toBe(true);
    const result = await tool.invoke({ names: ['app.lab.example'] }, runtime());
    const data = parse(result).data as Record<string, unknown>;
    expect(data.records).toEqual([
      { name: 'app.lab.example', records: [TARGET_IP, '2001:db8::7'] },
    ]);
    expect(calls[0]?.stdin).toBe('app.lab.example\n');
  });

  it('denies a name outside the scope and never resolves it', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createRunDnsxTool(session(executor)).invoke(
      { names: ['app.lab.example', 'victim.example.com'] },
      runtime(),
    );
    expect(parse(result)).toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
    expect(calls).toHaveLength(0);
  });

  it('records the version pinned for dnsx in the audit trail', async () => {
    const { executor } = fakeExecutor({ dnsx: line({ host: 'app.lab.example', a: [TARGET_IP] }) });
    const ctx = runtime();
    await createRunDnsxTool(session(executor)).invoke({ names: ['app.lab.example'] }, ctx);
    expect(wrapperAudits(ctx)[0]).toMatchObject({
      toolName: 'mcp__target__run_dnsx',
      toolVersion: '1.2.2',
      outcome: 'success',
    });
  });
});

describe('pinned versions and metrics', () => {
  it('refuses to start without a pinned version for each binary', () => {
    const bad = session(fakeExecutor().executor, {
      toolVersions: { httpx: '', naabu: '2.3.4', dnsx: '1.2.2' },
    });
    expect(() => createRunHttpxTool(bad)).toThrow(TypeError);
    const unsafe = session(fakeExecutor().executor, {
      toolVersions: { httpx: '1.6.9;rm', naabu: '2.3.4', dnsx: '1.2.2' },
    });
    expect(() => createRunHttpxTool(unsafe)).toThrow(/pinned version/);
  });

  it('counts each run by tool and result and records its duration', async () => {
    const registry = new Registry();
    const metrics = createReconRunMetrics(registry);
    const { executor } = fakeExecutor(
      { dnsx: line({ host: 'app.lab.example', a: [TARGET_IP] }) },
      'naabu',
    );
    const s = session(executor, { metrics });
    const ctx = runtime();
    await createRunDnsxTool(s).invoke({ names: ['app.lab.example'] }, ctx);
    await createRunNaabuTool(s).invoke({ hosts: [TARGET_IP], ports: [80] }, ctx);
    const text = await registry.metrics();
    expect(text).toContain('mcp_recon_runs_total{tool="dnsx",result="success"} 1');
    expect(text).toContain(
      'mcp_recon_runs_total{tool="naabu",result="TOOL_BACKEND_UNAVAILABLE"} 1',
    );
    expect(text).toContain('mcp_recon_duration_ms_count{tool="dnsx"} 1');
  });
});

describe('egress forcing', () => {
  it('sets the gateway as proxy for every child and wraps the proxy-unaware tools', async () => {
    const { egressSpawnOptions, PROXYCHAINS_CONFIG } = await import('./exec.js');
    const options = egressSpawnOptions('socks5://egress.internal:1080');
    expect(options.env).toEqual({
      HTTP_PROXY: 'socks5://egress.internal:1080',
      HTTPS_PROXY: 'socks5://egress.internal:1080',
      ALL_PROXY: 'socks5://egress.internal:1080',
    });
    expect(options.commands?.naabu).toEqual([
      'proxychains4',
      '-q',
      '-f',
      PROXYCHAINS_CONFIG,
      'naabu',
    ]);
    expect(options.commands?.dnsx).toEqual([
      'proxychains4',
      '-q',
      '-f',
      PROXYCHAINS_CONFIG,
      'dnsx',
    ]);
  });

  it('passes the forced environment to the child and nothing else from the parent', async () => {
    vi.stubEnv('BW_SECRET_TOKEN', 'must-not-leak');
    try {
      const { createSpawnExecutor } = await import('./exec.js');
      const probe = `process.stdout.write(JSON.stringify({ proxy: process.env.HTTPS_PROXY ?? null, secret: process.env.BW_SECRET_TOKEN ?? null }))`;
      const executor = createSpawnExecutor({
        commands: { dnsx: [process.execPath, '-e', probe] },
        env: { HTTPS_PROXY: 'http://egress.internal:3128' },
      });
      const out = await executor.run('dnsx', [], {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      });
      expect(JSON.parse(out)).toEqual({ proxy: 'http://egress.internal:3128', secret: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
