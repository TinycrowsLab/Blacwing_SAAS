import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSdkMcpServer, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_PERSONAS,
  type AgentSessionDescriptor,
  type AgentSessionPersona,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { EXPOSURE_MATRIX } from '@blackwing/mcp-tools';

import { createRuntimeMetrics } from '../metrics.js';
import {
  type AgentOptionsConfig,
  assertPermissionMode,
  buildOptions,
  mcpServerNamesFor,
  MINIMAL_ENV_KEYS,
  serverOfTool,
} from './options.js';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SHA = 'b'.repeat(64);
const TOKEN = 'bwrun_c2VjcmV0LXRva2VuLXZhbHVl.c2lnbmF0dXJl';
const VIRTUAL_KEY = 'bwk_test_virtual_key_value';
const OTEL_KEY_PATTERN = /^OTEL_[A-Z0-9_]+$/;

/** Every server name any persona row names, mounted as a real in-process SDK server with no tools. */
const ALL_SERVER_NAMES = [
  ...new Set(Object.values(EXPOSURE_MATRIX).flatMap((row) => serversOf(row))),
].sort();

function serverRegistry(
  names: readonly string[] = ALL_SERVER_NAMES,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    names.map((name) => [name, createSdkMcpServer({ name, version: '1.0.0', tools: [] })]),
  );
}

/** The distinct server names an exposure row names, in row order. Built-ins such as `Bash` name none. */
function serversOf(row: readonly string[]): string[] {
  return row
    .map((tool) => serverOfTool(tool))
    .filter((server): server is string => server !== undefined);
}

let root: string;
let workspaceDir: string;

function descriptor(overrides: Partial<AgentSessionDescriptor> = {}): AgentSessionDescriptor {
  return {
    runId: RUN,
    sessionId: SESSION,
    tenantId: TENANT,
    persona: 'planner',
    personaVersion: '1.0.0',
    promptSha256: SHA,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 10,
    maxBudgetUsd: 1,
    allowedTools: ['Read'],
    disallowedTools: ['WebFetch'],
    brief: 'Plan the next subtask.',
    envelopeHash: SHA,
    brokerBaseUrl: 'http://127.0.0.1:8080',
    brokerToken: TOKEN,
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk-run-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir,
    ...overrides,
  };
}

function config(overrides: Partial<AgentOptionsConfig> = {}): AgentOptionsConfig {
  return {
    egressProxyUrl: 'http://egress.internal:3128',
    resolveVirtualKey: () => VIRTUAL_KEY,
    providerPolicy: { allowFallbackModel: false },
    mcpServers: serverRegistry(),
    ...overrides,
  };
}

/** Rejects with the thrown `AppError`, or fails the test when the call succeeds. */
function errorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bw options '));
  // A space and non-ASCII characters in the working directory must be handled as plain path bytes.
  workspaceDir = join(root, 'session 工作区');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildOptions: environment isolation', () => {
  it('builds env from the explicit allowlist with every required key', () => {
    const env =
      buildOptions(
        descriptor(),
        config({ otelEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.internal:4318' } }),
      ).env ?? {};
    for (const key of MINIMAL_ENV_KEYS) {
      expect(env, key).toHaveProperty(key);
    }
    expect(env.ANTHROPIC_BASE_URL).toBe('http://model-gateway.internal:8443');
    expect(env.ANTHROPIC_API_KEY).toBe(VIRTUAL_KEY);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/bw/ca.pem');
    expect(env.SSL_CERT_FILE).toBe('/etc/bw/ca.pem');
    expect(env.REQUESTS_CA_BUNDLE).toBe('/etc/bw/ca.pem');
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(workspaceDir, '.claude'));
  });

  it('never carries a host env var, even one set in the container', () => {
    const saved = [
      ['AWS_SECRET_ACCESS_KEY', process.env.AWS_SECRET_ACCESS_KEY],
      ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY],
      ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ] as const;
    process.env.AWS_SECRET_ACCESS_KEY = 'host-aws-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-host-provider-key';
    process.env.OPENAI_API_KEY = 'sk-openai-host-key';
    try {
      const env = buildOptions(descriptor(), config()).env ?? {};
      expect(Object.keys(env)).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(Object.keys(env)).not.toContain('OPENAI_API_KEY');
      expect(Object.values(env)).not.toContain('sk-ant-host-provider-key');
      expect(env.ANTHROPIC_API_KEY).toBe(VIRTUAL_KEY);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  it('does not read process.env in the options module', () => {
    const source = readFileSync(new URL('./options.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
  });

  it('admits OTEL_* settings from config and drops every other key', () => {
    const env =
      buildOptions(
        descriptor(),
        config({
          otelEnv: {
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.internal:4318',
            AWS_SECRET_ACCESS_KEY: 'must-not-appear',
            PATH: '/evil',
          },
        }),
      ).env ?? {};
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel.internal:4318');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  });

  it('disables telemetry gracefully, without failing, when no OTEL_* setting is present', () => {
    const env = buildOptions(descriptor(), config({ otelEnv: {} })).env ?? {};
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0');
    expect(Object.keys(env).filter((key) => OTEL_KEY_PATTERN.test(key))).toEqual([]);
  });

  it('routes the egress proxy with the session identity as username and no password', () => {
    const env = buildOptions(descriptor(), config()).env ?? {};
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      const proxy = new URL(env[key] ?? '');
      expect(proxy.hostname).toBe('egress.internal');
      expect(proxy.username).toBe(SESSION);
      expect(proxy.password).toBe('');
    }
  });

  it('refuses an egress proxy URL that carries a password', () => {
    const error = errorOf(() =>
      buildOptions(
        descriptor(),
        config({ egressProxyUrl: 'http://id:secret@egress.internal:3128' }),
      ),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });
});

describe('buildOptions: settings, model and permissions', () => {
  it('never loads filesystem settings and always runs in default permission mode', () => {
    const options = buildOptions(descriptor(), config());
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options.includePartialMessages).toBe(true);
    expect(options.thinking).toEqual({ type: 'adaptive' });
  });

  it('passes the exact model, effort and turn ceiling from the descriptor', () => {
    const options = buildOptions(
      descriptor({ model: 'claude-opus-5-5', effort: 'max', maxTurns: 80 }),
      config(),
    );
    expect(options.model).toBe('claude-opus-5-5');
    expect(options.effort).toBe('max');
    expect(options.maxTurns).toBe(80);
  });

  it('omits fallbackModel unless the tenant policy flag is true', () => {
    const denied = buildOptions(
      descriptor(),
      config({ providerPolicy: { allowFallbackModel: false, fallbackModel: 'claude-haiku-5-5' } }),
    );
    expect(denied).not.toHaveProperty('fallbackModel');

    const allowed = buildOptions(
      descriptor(),
      config({ providerPolicy: { allowFallbackModel: true, fallbackModel: 'claude-haiku-5-5' } }),
    );
    expect(allowed.fallbackModel).toBe('claude-haiku-5-5');
  });

  it('omits fallbackModel when the policy allows one but names none', () => {
    const options = buildOptions(
      descriptor(),
      config({ providerPolicy: { allowFallbackModel: true } }),
    );
    expect(options).not.toHaveProperty('fallbackModel');
  });

  it.each(['bypassPermissions', 'dontAsk', 'auto', 'acceptEdits', 'plan', ''])(
    'throws AGENT_FORBIDDEN_PERMISSION_MODE for %j',
    (mode) => {
      expect(errorOf(() => assertPermissionMode(mode)).code).toBe(
        'AGENT_FORBIDDEN_PERMISSION_MODE',
      );
    },
  );

  it('accepts only the default permission mode', () => {
    expect(assertPermissionMode('default')).toBe('default');
  });
});

describe('buildOptions: working directory and budget', () => {
  it('uses the per-session workspace as cwd and creates it when absent', () => {
    expect(existsSync(workspaceDir)).toBe(false);
    const options = buildOptions(descriptor(), config());
    expect(options.cwd).toBe(workspaceDir);
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('handles spaces and non-ASCII characters in workspaceDir', () => {
    const options = buildOptions(descriptor(), config());
    expect(options.cwd).toContain('工作区');
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('caps the budget at the descriptor value when no remaining budget is given', () => {
    expect(buildOptions(descriptor({ maxBudgetUsd: 2.5 }), config()).maxBudgetUsd).toBe(2.5);
  });

  it('lowers the budget to the remaining session budget when that is smaller', () => {
    expect(
      buildOptions(descriptor({ maxBudgetUsd: 2.5 }), config({ budgetRemainingUsd: 0.75 }))
        .maxBudgetUsd,
    ).toBe(0.75);
    expect(
      buildOptions(descriptor({ maxBudgetUsd: 2.5 }), config({ budgetRemainingUsd: 9 }))
        .maxBudgetUsd,
    ).toBe(2.5);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an exhausted or invalid budget (%s) with AGENT_BUDGET_EXHAUSTED and creates no workspace',
    (remaining) => {
      const error = errorOf(() =>
        buildOptions(descriptor(), config({ budgetRemainingUsd: remaining })),
      );
      expect(error.code).toBe('AGENT_BUDGET_EXHAUSTED');
      expect(existsSync(workspaceDir)).toBe(false);
    },
  );
});

describe('buildOptions: virtual key', () => {
  it('fails closed with AGENT_NO_VIRTUAL_KEY when the key is missing and creates no session', () => {
    const error = errorOf(() =>
      buildOptions(descriptor(), config({ resolveVirtualKey: () => undefined })),
    );
    expect(error.code).toBe('AGENT_NO_VIRTUAL_KEY');
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it('fails closed when the resolver throws', () => {
    const error = errorOf(() =>
      buildOptions(
        descriptor(),
        config({
          resolveVirtualKey: () => {
            throw new Error('vault down');
          },
        }),
      ),
    );
    expect(error.code).toBe('AGENT_NO_VIRTUAL_KEY');
  });

  it('refuses a resolved value that is not a bwk_ virtual key', () => {
    const error = errorOf(() =>
      buildOptions(descriptor(), config({ resolveVirtualKey: () => 'sk-ant-raw-provider-key' })),
    );
    expect(error.code).toBe('AGENT_NO_VIRTUAL_KEY');
    expect(
      errorOf(() => buildOptions(descriptor(), config({ resolveVirtualKey: () => 'bwk_' }))).code,
    ).toBe('AGENT_NO_VIRTUAL_KEY');
  });
});

describe('buildOptions: mounted MCP servers', () => {
  it('mounts exactly the servers the orchestrator row names', () => {
    expect(
      Object.keys(buildOptions(descriptor({ persona: 'orchestrator' }), config()).mcpServers ?? {}),
    ).toEqual(['blackwing_engagement']);
  });

  it('mounts the web-api-specialist servers, including the browser', () => {
    const mounted = Object.keys(
      buildOptions(descriptor({ persona: 'web-api-specialist' }), config()).mcpServers ?? {},
    );
    expect(mounted).toEqual(
      expect.arrayContaining([
        'blackwing_target',
        'blackwing_oob',
        'blackwing_journal',
        'blackwing_findings',
        'playwright',
      ]),
    );
    expect(mounted).not.toContain('blackwing_intel');
  });

  it('fails closed with AGENT_MCP_SERVER_MISSING when a required server is not provided', () => {
    const error = errorOf(() =>
      buildOptions(
        descriptor({ persona: 'planner' }),
        config({ mcpServers: serverRegistry(['blackwing_surface']) }),
      ),
    );
    expect(error.code).toBe('AGENT_MCP_SERVER_MISSING');
    expect(error.detail).toBe('missing server: blackwing_testcases');
  });

  it('never mounts a global map: a server outside the persona row is not mounted', () => {
    const mounted = Object.keys(
      buildOptions(descriptor({ persona: 'planner' }), config()).mcpServers ?? {},
    );
    expect(mounted).toEqual(['blackwing_surface', 'blackwing_testcases']);
  });

  it('refuses an unknown persona with AGENT_UNKNOWN_PERSONA and does not default to all servers', () => {
    const error = errorOf(() =>
      buildOptions(descriptor({ persona: 'not-a-persona' as AgentSessionPersona }), config()),
    );
    expect(error.code).toBe('AGENT_UNKNOWN_PERSONA');
    expect(() => mcpServerNamesFor('not-a-persona')).toThrow(AppError);
  });

  it('gives every one of the 19 personas exactly the servers its exposure row backs', () => {
    expect(AGENT_SESSION_PERSONAS).toHaveLength(19);
    for (const persona of AGENT_SESSION_PERSONAS) {
      const row = EXPOSURE_MATRIX[persona];
      const expectedServers = [...new Set(serversOf(row))].sort();
      const mounted = buildOptions(descriptor({ persona }), config()).mcpServers ?? {};
      expect(Object.keys(mounted).sort(), persona).toEqual(expectedServers);

      // The session's exposed names (mounted servers intersected with the row) are exactly the row.
      const exposed = row.filter((tool) => {
        const server = serverOfTool(tool);
        return server === undefined || Object.hasOwn(mounted, server);
      });
      expect(exposed, persona).toEqual([...row]);
      expect(row, persona).not.toContain('WebFetch');
      expect(row, persona).not.toContain('WebSearch');
    }
  });
});

describe('buildOptions: tool gate (RUNTIME-003)', () => {
  const context = { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'rq-1' };

  it('carries the allowlist and the always-denied networked built-ins into the options', () => {
    const opts = buildOptions(
      descriptor({ allowedTools: ['Read', 'mcp__http__*'], disallowedTools: ['Bash'] }),
      config(),
    );
    expect(opts.allowedTools).toEqual(['Read', 'mcp__http__*']);
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'WebFetch', 'WebSearch', 'WebRequest']),
    );
  });

  it('wires a deny-by-default canUseTool that never allows an undeclared tool', async () => {
    const opts = buildOptions(descriptor({ allowedTools: ['Read'] }), config());
    const decide = opts.canUseTool;
    if (!decide) throw new Error('canUseTool must be set');
    await expect(decide('Read', {}, context)).resolves.toMatchObject({ behavior: 'allow' });
    await expect(decide('WebFetch', {}, context)).resolves.toMatchObject({ behavior: 'deny' });
    await expect(decide('mcp__shell__run', {}, context)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('refuses an allowlist that names a networked built-in, before the working directory exists', () => {
    const error = errorOf(() =>
      buildOptions(descriptor({ allowedTools: ['Read', 'WebSearch'] }), config()),
    );
    expect(error.code).toBe('AGENT_FORBIDDEN_TOOL');
    expect(existsSync(workspaceDir)).toBe(false);
  });
});

describe('buildOptions: audit and observability', () => {
  it('reports the mounted server names, and an options hash that excludes the key', () => {
    const events: unknown[] = [];
    const metrics = createRuntimeMetrics();
    buildOptions(
      descriptor({ persona: 'web-api-specialist' }),
      config({ metrics, onBuilt: (event) => events.push(event) }),
    );
    expect(events).toHaveLength(1);
    const event = events[0] as { mcpServers: string[]; optionsSha256: string; model: string };
    expect(event.mcpServers).toContain('blackwing_target');
    expect(event.model).toBe('claude-haiku-5-5');
    expect(JSON.stringify(event)).not.toContain(VIRTUAL_KEY);
    expect(event.optionsSha256).toMatch(/^[0-9a-f]{64}$/);

    const rekeyed: unknown[] = [];
    buildOptions(
      descriptor({ persona: 'web-api-specialist' }),
      config({ resolveVirtualKey: () => 'bwk_rotated_other_key', onBuilt: (e) => rekeyed.push(e) }),
    );
    expect((rekeyed[0] as { optionsSha256: string }).optionsSha256).toBe(event.optionsSha256);
  });

  it('counts each built session by persona', async () => {
    const metrics = createRuntimeMetrics();
    buildOptions(descriptor(), config({ metrics }));
    const text = await metrics.registry.metrics();
    expect(text).toContain('agent_runtime_options_built_total{persona="planner"} 1');
  });
});

describe('buildOptions: property tests', () => {
  it('never admits an env key outside the allowlist or the OTEL_ namespace', () => {
    const otelKeys = fc.array(fc.stringMatching(/^[A-Z_]{1,12}$/), { maxLength: 6 });
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 20 }), fc.string({ maxLength: 40 }), { maxKeys: 8 }),
        otelKeys,
        fc.integer({ min: 1, max: 1000 }),
        (extra, keyNames, maxTurns) => {
          const otelEnv: Record<string, string> = { ...extra };
          for (const name of keyNames) otelEnv[`OTEL_${name}`] = 'v';
          const options = buildOptions(descriptor({ maxTurns }), config({ otelEnv }));
          const keys = Object.keys(options.env ?? {});
          const allowed = new Set<string>(MINIMAL_ENV_KEYS);
          for (const key of keys) {
            expect(allowed.has(key) || OTEL_KEY_PATTERN.test(key)).toBe(true);
          }
          expect(keys).not.toContain('AWS_SECRET_ACCESS_KEY');
        },
      ),
      { numRuns: 60 },
    );
  });
});
