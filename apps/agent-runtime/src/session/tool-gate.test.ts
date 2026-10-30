import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadPersona } from '@blackwing/agents';
import { AppError } from '@blackwing/errors';

import {
  ALWAYS_DISALLOWED,
  assertNoForbiddenAllow,
  buildToolGate,
  createCanUseTool,
  denialReason,
} from './tool-gate.js';

const NETWORKED_BUILTINS = ['WebFetch', 'WebSearch', 'WebRequest'];

/** The error an assertion throws, or a failed test when the call does not throw. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('ALWAYS_DISALLOWED', () => {
  it('names the networked built-ins that bypass the egress path', () => {
    expect(ALWAYS_DISALLOWED).toEqual(expect.arrayContaining(NETWORKED_BUILTINS));
  });
});

describe('buildToolGate: disallowed set', () => {
  it('always disallows WebFetch, WebSearch and WebRequest, even when the descriptor omits them', () => {
    const gate = buildToolGate({ allowedTools: ['Read'], disallowedTools: [] });
    expect(gate.disallowedTools).toEqual(expect.arrayContaining(NETWORKED_BUILTINS));
  });

  it('keeps the descriptor deny list and removes duplicates', () => {
    const gate = buildToolGate({
      allowedTools: ['Read'],
      disallowedTools: ['Bash', 'WebFetch', 'Bash'],
    });
    expect(gate.disallowedTools).toEqual(expect.arrayContaining(['Bash', ...NETWORKED_BUILTINS]));
    expect(new Set(gate.disallowedTools).size).toBe(gate.disallowedTools.length);
  });

  it('passes the allowlist through exactly', () => {
    const gate = buildToolGate({
      allowedTools: ['Read', 'mcp__http__*'],
      disallowedTools: [],
    });
    expect(gate.allowedTools).toEqual(['Read', 'mcp__http__*']);
  });
});

describe('assertNoForbiddenAllow', () => {
  it.each([
    ['WebFetch'],
    ['WebSearch'],
    ['WebRequest'],
    ['WebFetch(https://example.test/*)'],
    ['Web*'],
    ['WebF*'],
  ])('refuses an allowlist entry %s with AGENT_FORBIDDEN_TOOL', (entry) => {
    expect(
      codeOf(() => {
        assertNoForbiddenAllow({ allowedTools: ['Read', entry] });
      }),
    ).toBe('AGENT_FORBIDDEN_TOOL');
  });

  it('accepts an allowlist with no networked built-in', () => {
    expect(() => {
      assertNoForbiddenAllow({ allowedTools: ['Read', 'Bash', 'mcp__http__*', 'Agent'] });
    }).not.toThrow();
  });

  it('does not refuse a name that only shares a prefix with a built-in', () => {
    expect(() => {
      assertNoForbiddenAllow({ allowedTools: ['WebPage', 'mcp__web__fetch'] });
    }).not.toThrow();
  });

  it('fails the whole gate build, so no partial gate is returned', () => {
    expect(
      codeOf(() => buildToolGate({ allowedTools: ['WebFetch'], disallowedTools: ['Bash'] })),
    ).toBe('AGENT_FORBIDDEN_TOOL');
  });
});

describe('createCanUseTool: deny by default', () => {
  it('allows nothing when the allowlist is empty', async () => {
    const gate = createCanUseTool([], ['Bash']);
    for (const tool of ['Read', 'Bash', 'mcp__http__request']) {
      await expect(gate(tool, {})).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('denies a tool absent from the allowlist, with a reason that names it', async () => {
    const gate = createCanUseTool(['Read'], []);
    const decision = await gate('Grep', {});
    expect(decision).toEqual({ behavior: 'deny', message: 'tool Grep is not declared' });
  });

  it('denies a model attempt at an unknown tool', async () => {
    const gate = createCanUseTool(['Read'], []);
    await expect(gate('mcp__shell__run', {})).resolves.toMatchObject({
      behavior: 'deny',
      message: 'tool mcp__shell__run is not declared',
    });
  });

  it('matches tool names exactly, including case', async () => {
    const gate = createCanUseTool(['Read'], []);
    await expect(gate('read', {})).resolves.toMatchObject({ behavior: 'deny' });
    await expect(gate('Read', {})).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('matches an mcp__server__tool name exactly, never by a shared prefix', async () => {
    const gate = createCanUseTool(['mcp__http__request'], []);
    await expect(gate('mcp__http__request_admin', {})).resolves.toMatchObject({
      behavior: 'deny',
    });
    await expect(gate('mcp__http', {})).resolves.toMatchObject({ behavior: 'deny' });
    await expect(gate('mcp__http__request', {})).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('matches a trailing-wildcard pattern only on its full separator-bounded prefix', async () => {
    const gate = createCanUseTool(['mcp__http__*'], []);
    await expect(gate('mcp__http__get', {})).resolves.toMatchObject({ behavior: 'allow' });
    await expect(gate('mcp__httpx__get', {})).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('lets a disallowed rule win over an allowed one', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash']);
    await expect(gate('Bash', {})).resolves.toEqual({
      behavior: 'deny',
      message: 'tool Bash is disallowed',
    });
  });

  it('refuses a catch-all allowlist', () => {
    expect(() => createCanUseTool(['*'], [])).toThrow(/PERSONA_FORBIDDEN_TOOL/);
  });

  it('never returns allow for a tool outside the allowlist, whatever the input', async () => {
    const gate = createCanUseTool(['Read'], []);
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,24}$/).filter((name) => name !== 'Read'),
        fc.dictionary(fc.string(), fc.string()),
        async (name, input) => {
          const decision = await gate(name, input);
          expect(decision.behavior).toBe('deny');
        },
      ),
    );
  });
});

describe('createCanUseTool: scoped rules', () => {
  it('denies a scoped deny rule on a matching command even when the tool is allowed', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash(rm *)']);
    await expect(gate('Bash', { command: 'rm -rf /workspace/a' })).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('ignores leading whitespace when matching a scoped deny rule', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash(rm *)']);
    await expect(gate('Bash', { command: '   rm -rf /workspace/a' })).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('allows a command that the scoped deny rule does not match', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash(rm *)']);
    await expect(gate('Bash', { command: 'ls /workspace/a' })).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('fails closed when a scoped deny rule has no command to check', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash(rm *)']);
    await expect(gate('Bash', {})).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('treats regex metacharacters in a scope literally', async () => {
    const gate = createCanUseTool(['Bash'], ['Bash(cat .env*)']);
    await expect(gate('Bash', { command: 'cat .env.local' })).resolves.toMatchObject({
      behavior: 'deny',
    });
    await expect(gate('Bash', { command: 'catXenv' })).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('applies a scoped allow rule only when the command matches', async () => {
    const gate = createCanUseTool(['Bash(git status*)'], []);
    await expect(gate('Bash', { command: 'git status --short' })).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(gate('Bash', { command: 'git push' })).resolves.toMatchObject({
      behavior: 'deny',
    });
  });
});

describe('createCanUseTool: subagent name aliases', () => {
  it('gates Task under the Agent name, in both directions', async () => {
    const allowAgent = createCanUseTool(['Agent'], []);
    await expect(allowAgent('Task', {})).resolves.toMatchObject({ behavior: 'allow' });

    const denyTask = createCanUseTool(['Agent'], ['Task']);
    await expect(denyTask('Agent', {})).resolves.toMatchObject({ behavior: 'deny' });
  });
});

describe('denialReason', () => {
  const disallowed = buildToolGate({
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
  }).disallowedTools;

  it('classifies an always-denied networked built-in', () => {
    expect(denialReason('WebFetch', disallowed)).toBe('always_disallowed');
  });

  it('classifies a descriptor-denied tool', () => {
    expect(denialReason('Bash', disallowed)).toBe('disallowed');
  });

  it('classifies a tool the session never declared', () => {
    expect(denialReason('mcp__shell__run', disallowed)).toBe('not_declared');
  });

  it('classifies a scoped deny by its tool name', () => {
    expect(denialReason('Bash', ['Bash(rm *)'])).toBe('disallowed');
  });
});

describe('infrastructure-specialist gate', () => {
  const persona = loadPersona('infrastructure-specialist');
  const gate = buildToolGate(persona).canUseTool;

  it('allows the pinned scanners through Bash and the declared probe tool', async () => {
    await expect(gate('Bash', { command: 'naabu -host 10.0.0.5 -p 443' })).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(gate('Bash', { command: 'testssl.sh 10.0.0.5:443' })).resolves.toMatchObject({
      behavior: 'allow',
    });
    await expect(
      gate('mcp__blackwing_target__tcp_probe', { host: '10.0.0.5' }),
    ).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('denies nmap in every Bash command position', async () => {
    for (const command of [
      'nmap -sV 10.0.0.5',
      '   nmap -sV 10.0.0.5',
      '/usr/bin/nmap -sV 10.0.0.5',
      'cd /tmp && nmap -sV 10.0.0.5',
      'naabu -host 10.0.0.5 && nmap 10.0.0.5',
    ]) {
      await expect(gate('Bash', { command })).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('denies networked built-ins and undeclared tools', async () => {
    for (const tool of ['WebFetch', 'WebSearch', 'Write', 'mcp__blackwing_findings__update']) {
      await expect(gate(tool, { url: 'https://10.0.0.5' })).resolves.toMatchObject({
        behavior: 'deny',
      });
    }
  });
});
