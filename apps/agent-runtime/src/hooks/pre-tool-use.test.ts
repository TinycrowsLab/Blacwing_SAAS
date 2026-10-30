import { describe, expect, it } from 'vitest';

import { createPreToolUseHook, type PdpBroker, type PreToolUsePorts } from './pre-tool-use.js';

const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8057';
const CONTEXT = { subtaskId: SUBTASK, testCaseId: null, roleId: 'auth-specialist' };
const hookInput = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'toolu_1',
  session_id: 'sess',
});

interface Harness {
  readonly calls: { suffix: string; body: unknown }[];
  readonly decided: { decision: string; reason: string }[];
  readonly latencies: number[];
  readonly logs: Readonly<Record<string, string>>[];
  readonly ports: PreToolUsePorts;
}

function harness(
  answer: (suffix: string, body: unknown) => Promise<unknown>,
  timeoutMs = 1500,
): Harness {
  const calls: { suffix: string; body: unknown }[] = [];
  const decided: { decision: string; reason: string }[] = [];
  const latencies: number[] = [];
  const logs: Readonly<Record<string, string>>[] = [];
  const broker: PdpBroker = {
    post: (async (suffix: string, body: unknown, schema: { parse: (v: unknown) => unknown }) => {
      calls.push({ suffix, body });
      return schema.parse(await answer(suffix, body));
    }) as PdpBroker['post'],
  };
  return {
    calls,
    decided,
    latencies,
    logs,
    ports: {
      broker,
      timeoutMs,
      metrics: {
        decided: (labels) => {
          decided.push(labels);
        },
        latency: (ms) => {
          latencies.push(ms);
        },
      },
      log: {
        info: (fields) => {
          logs.push(fields);
        },
      },
    },
  };
}

const allow = () => Promise.resolve({ decision: 'allow', reason: 'in_envelope' });
const denyOutOfScope = () => Promise.resolve({ decision: 'deny', reason: 'out_of_scope' });

describe('PreToolUse hook (RUNTIME-005)', () => {
  it('returns allow for an in-envelope call, in the SDK output shape', async () => {
    const h = harness(allow);
    const hook = createPreToolUseHook(h.ports, CONTEXT);
    const out = await hook(hookInput('Bash', { command: 'curl https://lab.example.test/' }));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'in_envelope',
      },
    });
    expect(h.calls).toEqual([
      {
        suffix: 'pdp/evaluate',
        body: {
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          targets: ['https://lab.example.test/'],
          subtaskId: SUBTASK,
          testCaseId: null,
          roleId: 'auth-specialist',
        },
      },
    ]);
  });

  it('returns deny with the PDP reason for an out-of-scope call', async () => {
    const h = harness(denyOutOfScope);
    const out = await createPreToolUseHook(
      h.ports,
      CONTEXT,
    )(hookInput('Bash', { command: 'curl https://other.example.test/' }));
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'out_of_scope',
    });
  });

  it('denies with invalid_input for a malformed hook input, without calling the broker', async () => {
    const h = harness(allow);
    const hook = createPreToolUseHook(h.ports, CONTEXT);
    for (const bad of [null, 'x', { hook_event_name: 'PostToolUse' }, hookInput('', {})]) {
      const out = await hook(bad);
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe('invalid_input');
    }
    expect(h.calls).toHaveLength(0);
  });

  it('denies with target_unresolved and never calls the PDP for an unresolvable target', async () => {
    const h = harness(allow);
    const out = await createPreToolUseHook(
      h.ports,
      CONTEXT,
    )(hookInput('Bash', { command: 'nc -z' }));
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('target_unresolved');
    expect(h.calls).toHaveLength(0);
  });

  it('fails closed with pdp_unavailable when the broker is unreachable', async () => {
    const h = harness(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const out = await createPreToolUseHook(h.ports, CONTEXT)(hookInput('Bash', { command: 'ls' }));
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'pdp_unavailable',
    });
  });

  it('fails closed with pdp_unavailable for a malformed PDP answer, never allow', async () => {
    const h = harness(() => Promise.resolve({ decision: 'allow', reason: 'whatever' }));
    const out = await createPreToolUseHook(h.ports, CONTEXT)(hookInput('Bash', { command: 'ls' }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('pdp_unavailable');
  });

  it('denies with pdp_timeout when the PDP does not answer within the bound', async () => {
    const h = harness(() => new Promise<never>(() => undefined), 5);
    const out = await createPreToolUseHook(h.ports, CONTEXT)(hookInput('Bash', { command: 'ls' }));
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'pdp_timeout',
    });
  });

  it('counts each decision by decision and reason and times it, and logs no call input', async () => {
    const h = harness(denyOutOfScope);
    const secret = 'https://lab.example.test/?token=hunter2-SECRET';
    await createPreToolUseHook(h.ports, CONTEXT)(hookInput('Bash', { command: `curl ${secret}` }));
    expect(h.decided).toEqual([{ decision: 'deny', reason: 'out_of_scope' }]);
    expect(h.latencies).toHaveLength(1);
    expect(h.logs).toEqual([{ toolName: 'Bash', decision: 'deny', reason: 'out_of_scope' }]);
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
  });

  it('sends the broker only the ids, the tool name and redacted targets, never the input', async () => {
    const h = harness(allow);
    await createPreToolUseHook(h.ports, { subtaskId: null, testCaseId: null, roleId: null })(
      hookInput('mcp__recon__probe', {
        url: 'https://lab.example.test/a?secret=1',
        body: 'PAYLOAD',
      }),
    );
    expect(JSON.stringify(h.calls[0]?.body)).not.toContain('PAYLOAD');
    expect(JSON.stringify(h.calls[0]?.body)).not.toContain('secret=1');
  });
});
