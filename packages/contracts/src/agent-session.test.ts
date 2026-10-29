import { describe, expect, it } from 'vitest';

import {
  AGENT_BRIEF_MAX_BYTES,
  AGENT_SESSION_PERSONAS,
  agentSessionDescriptorSchema,
  agentSessionRecordSchema,
} from './agent-session.js';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SUBTASK = '01920000-0000-7000-8000-000000000004';
const SHA = 'a'.repeat(64);

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    disallowedTools: ['WebFetch', 'WebSearch'],
    subtaskId: SUBTASK,
    brief: 'Test the login form for SQL injection. Résumé ✓ 日本語',
    envelopeHash: SHA,
    brokerBaseUrl: 'http://run-broker.internal:8080',
    brokerToken: 'bwrun_eyJ2IjoxfQ.c2ln',
    modelGatewayBaseUrl: 'http://model-gateway.internal:8443',
    virtualKeyRef: 'vk/run-1/session-1',
    caBundlePath: '/etc/bw/ca.pem',
    workspaceDir: '/workspace/sessão-日本語',
    ...overrides,
  };
}

describe('agentSessionDescriptorSchema', () => {
  it('parses a complete descriptor and keeps the brief and workspace path verbatim', () => {
    const parsed = agentSessionDescriptorSchema.parse(descriptor());
    expect(parsed.brief).toBe('Test the login form for SQL injection. Résumé ✓ 日本語');
    expect(parsed.workspaceDir).toBe('/workspace/sessão-日本語');
    expect(parsed.roleId).toBeUndefined();
  });

  it('accepts the optional identifiers when they are present', () => {
    const parsed = agentSessionDescriptorSchema.parse(
      descriptor({ testCaseId: TENANT, roleId: 'role-user', outputSchemaId: 'candidate.v1' }),
    );
    expect(parsed.testCaseId).toBe(TENANT);
    expect(parsed.roleId).toBe('role-user');
  });

  it.each(['brokerToken', 'envelopeHash', 'virtualKeyRef'] as const)(
    'rejects a descriptor missing %s',
    (field) => {
      const input = descriptor();
      Reflect.deleteProperty(input, field);
      expect(agentSessionDescriptorSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects unknown fields so a stray credential cannot ride along', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ anthropicApiKey: 'sk-x' })).success,
    ).toBe(false);
  });

  it('refuses a raw virtual key value in place of a reference', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ virtualKeyRef: 'bwk_secretvalue' }))
        .success,
    ).toBe(false);
  });

  it('refuses a broker token that is not run-scoped', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ brokerToken: 'Bearer abc' })).success,
    ).toBe(false);
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ brokerToken: 'bwrun_a b' })).success,
    ).toBe(false);
  });

  it('refuses URLs that carry credentials or a non-http scheme', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(
        descriptor({ brokerBaseUrl: 'http://user:pw@run-broker.internal:8080' }),
      ).success,
    ).toBe(false);
    expect(
      agentSessionDescriptorSchema.safeParse(
        descriptor({ modelGatewayBaseUrl: 'file:///etc/passwd' }),
      ).success,
    ).toBe(false);
  });

  it('requires absolute paths for the workspace and CA bundle', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ workspaceDir: 'workspace/x' })).success,
    ).toBe(false);
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ caBundlePath: '../ca.pem' })).success,
    ).toBe(false);
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ workspaceDir: '/workspace/a\u0000b' }))
        .success,
    ).toBe(false);
  });

  it('accepts only persona names from the Agent Registry', () => {
    expect(AGENT_SESSION_PERSONAS).toHaveLength(19);
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ persona: 'hacker' })).success).toBe(
      false,
    );
  });

  it('rejects an effort level outside the allowed set', () => {
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ effort: 'extreme' })).success).toBe(
      false,
    );
  });

  it('rejects a non-integer or out-of-range turn ceiling and a non-positive budget', () => {
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ maxTurns: 2.5 })).success).toBe(
      false,
    );
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ maxTurns: 0 })).success).toBe(false);
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ maxBudgetUsd: 0 })).success).toBe(
      false,
    );
  });

  it('refuses a catch-all tool pattern and a malformed semver', () => {
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ allowedTools: ['*'] })).success,
    ).toBe(false);
    expect(
      agentSessionDescriptorSchema.safeParse(descriptor({ personaVersion: '1.2' })).success,
    ).toBe(false);
  });

  it('rejects a model alias that is not a full model identifier', () => {
    expect(agentSessionDescriptorSchema.safeParse(descriptor({ model: '' })).success).toBe(false);
  });

  it('exposes the brief size limit as 256 KiB', () => {
    expect(AGENT_BRIEF_MAX_BYTES).toBe(262_144);
  });
});

describe('agentSessionRecordSchema', () => {
  const record = {
    sessionId: SESSION,
    persona: 'planner',
    personaVersion: '1.0.0',
    promptSha256: SHA,
    model: 'claude-haiku-5-5',
    effort: 'low',
    sdkVersion: '0.3.308',
    status: 'success',
    numTurns: 3,
    totalCostUsd: 0.12,
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 10 } },
  };

  it('accepts a finished-session record', () => {
    expect(agentSessionRecordSchema.parse(record)).toEqual(record);
  });

  it('rejects unknown fields and negative cost', () => {
    expect(agentSessionRecordSchema.safeParse({ ...record, apiKey: 'x' }).success).toBe(false);
    expect(agentSessionRecordSchema.safeParse({ ...record, totalCostUsd: -1 }).success).toBe(false);
  });
});
