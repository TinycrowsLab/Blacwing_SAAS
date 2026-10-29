import { describe, expect, it } from 'vitest';

import { loadPersona, type PersonaDefinition, type RunContext } from '@blackwing/agents';

import { buildSessionOptions, createCanUseTool, type SessionOptionsInput } from './options.js';

const persona = loadPersona('web-api-specialist');

const runContext: RunContext = {
  saId: 'sa-683',
  approverIdentity: 'approver@example.com',
  assetScope: ['app.example.test'],
  testWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
  maxIntrusiveness: 'active_safe',
  roles: ['user'],
};

function input(overrides: Partial<SessionOptionsInput> = {}): SessionOptionsInput {
  return { persona, runContext, provider: 'anthropic', ...overrides };
}

describe('buildSessionOptions: model, effort and step ceiling', () => {
  it('pins the deep tier to claude-opus-5-5 with the persona effort and step ceiling', () => {
    const opts = buildSessionOptions(input());
    expect(opts.model).toBe('claude-opus-5-5');
    expect(opts.effort).toBe('high');
    expect(opts.maxTurns).toBe(80);
  });

  it('uses the Bedrock prefix for a Bedrock tenant and never a date-suffixed ID', () => {
    const opts = buildSessionOptions(input({ provider: 'bedrock' }));
    expect(opts.model).toBe('anthropic.claude-opus-5-5');
    expect(opts.model).not.toMatch(/-\d{8}$/);
  });

  it('does not let the eval lowering flag change a deep persona', () => {
    const opts = buildSessionOptions(input({ evalFlags: { lowerStandard: true } }));
    expect(opts.model).toBe('claude-opus-5-5');
  });

  it('fails closed for an unknown provider', () => {
    expect(() =>
      buildSessionOptions(input({ provider: 'unknown' as unknown as 'anthropic' })),
    ).toThrow(/MODEL_NOT_ALLOWED/);
  });

  it('fails closed when the model is missing from the gateway allowlist', () => {
    expect(() => buildSessionOptions(input({ allowlist: ['claude-haiku-5-5'] }))).toThrow(
      /MODEL_NOT_ALLOWED/,
    );
  });
});

describe('buildSessionOptions: budget', () => {
  it('uses the persona default budget when none remains to cap it', () => {
    const opts = buildSessionOptions(input());
    expect(opts.maxBudgetUsd).toBe(persona.maxBudgetUsdDefault);
  });

  it('lowers the budget to the remaining session budget when that is smaller', () => {
    const opts = buildSessionOptions(input({ budgetRemainingUsd: 1.25 }));
    expect(opts.maxBudgetUsd).toBe(1.25);
  });

  it('never raises the budget above the persona default', () => {
    const opts = buildSessionOptions(input({ budgetRemainingUsd: 10_000 }));
    expect(opts.maxBudgetUsd).toBe(persona.maxBudgetUsdDefault);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for a non-positive or non-finite remaining budget (%s)',
    (remaining) => {
      expect(() => buildSessionOptions(input({ budgetRemainingUsd: remaining }))).toThrow(
        /PERSONA_INVALID/,
      );
    },
  );
});

describe('buildSessionOptions: permissions and settings', () => {
  it('never loads sandbox settings and never bypasses permissions', () => {
    const opts = buildSessionOptions(input());
    expect(opts.settingSources).toEqual([]);
    expect(opts.permissionMode).toBe('default');
  });

  it('passes the persona tool lists through and excludes WebFetch and WebSearch', () => {
    const opts = buildSessionOptions(input());
    expect(opts.allowedTools).toEqual(persona.allowedTools);
    expect(opts.allowedTools).not.toContain('WebFetch');
    expect(opts.allowedTools).not.toContain('WebSearch');
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  });

  it('caps the effective intrusiveness at the lower of the run and the persona ceiling', () => {
    const wide = buildSessionOptions(
      input({ runContext: { ...runContext, maxIntrusiveness: 'state_changing' } }),
    );
    expect(wide.intrusivenessCeiling).toBe('active_safe');

    const narrow = buildSessionOptions(
      input({ runContext: { ...runContext, maxIntrusiveness: 'passive' } }),
    );
    expect(narrow.intrusivenessCeiling).toBe('passive');
  });
});

describe('buildSessionOptions: system prompt and authorisation context', () => {
  it('composes a system prompt that carries the signed authorisation block', () => {
    const opts = buildSessionOptions(input());
    expect(opts.systemPrompt).toContain('sa-683');
    expect(opts.systemPrompt).toContain('approver@example.com');
    expect(opts.systemPrompt).toContain('app.example.test');
    expect(opts.systemPrompt).toContain('untrusted');
  });

  it('pins the prompt and composed hashes as SHA-256 hex', () => {
    const opts = buildSessionOptions(input());
    expect(opts.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(opts.composedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = buildSessionOptions(input());
    const b = buildSessionOptions(input());
    expect(b.composedSha256).toBe(a.composedSha256);
  });

  it('fails closed when the run context lacks the authorisation fields', () => {
    const withoutSa: Record<string, unknown> = { ...runContext };
    delete withoutSa.saId;
    expect(() =>
      buildSessionOptions(input({ runContext: withoutSa as unknown as RunContext })),
    ).toThrow(/PROMPT_PLACEHOLDER_MISSING/);
  });

  it('rejects run-context keys that are not part of the contract (no smuggled secrets)', () => {
    expect(() =>
      buildSessionOptions(
        input({
          runContext: { ...runContext, apiKey: 'sk-live-secret' } as unknown as RunContext,
        }),
      ),
    ).toThrow(/PROMPT_INVALID/);
  });
});

describe('createCanUseTool: deny by default', () => {
  const gate = createCanUseTool(persona.allowedTools, persona.disallowedTools);

  it('allows the declared exact tools', async () => {
    await expect(gate('Bash', { command: 'true' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'true' },
    });
    await expect(gate('mcp__blackwing_target__http_request', {})).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(gate('mcp__blackwing_findings__submit_candidate', {})).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('allows names matched by a declared trailing-wildcard pattern', async () => {
    await expect(gate('mcp__playwright__browser_navigate', {})).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(gate('mcp__blackwing_journal__journal_record', {})).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('denies the networked built-ins', async () => {
    for (const tool of ['WebFetch', 'WebSearch']) {
      await expect(gate(tool, {})).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('denies undeclared and near-miss tool names', async () => {
    for (const tool of [
      'Write',
      'Edit',
      'bash',
      'BASH',
      'mcp__blackwing_target__http_request_v2',
      'mcp__blackwing_target__unknown',
      'mcp__playwright',
      'mcp__playwrightx__browser_navigate',
      '',
    ]) {
      const decision = await gate(tool, {});
      expect(decision.behavior, tool).toBe('deny');
    }
  });

  it('gives a non-empty deny message that names the tool', async () => {
    const decision = await gate('Write', {});
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' && decision.message).toContain('Write');
  });

  it('lets a disallowed pattern override an allowed one', async () => {
    const strict = createCanUseTool(
      ['mcp__blackwing_target__*'],
      ['mcp__blackwing_target__http_*'],
    );
    await expect(strict('mcp__blackwing_target__http_request', {})).resolves.toMatchObject({
      behavior: 'deny',
    });
    await expect(strict('mcp__blackwing_target__discover', {})).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('refuses a catch-all pattern in the allowlist', () => {
    expect(() => createCanUseTool(['*'], [])).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });

  it('refuses a persona whose allowlist is a catch-all, before any call', () => {
    const catchAll: PersonaDefinition = { ...persona, allowedTools: ['*'] };
    expect(() => buildSessionOptions(input({ persona: catchAll }))).toThrow(
      /PERSONA_FORBIDDEN_TOOL/,
    );
  });

  it('keeps the gate in force for the options it returns', async () => {
    const opts = buildSessionOptions(input());
    await expect(opts.canUseTool('WebSearch', {})).resolves.toMatchObject({ behavior: 'deny' });
    await expect(opts.canUseTool('Bash', {})).resolves.toMatchObject({ behavior: 'allow' });
  });
});
