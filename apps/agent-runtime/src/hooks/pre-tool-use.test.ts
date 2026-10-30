import { describe, expect, it } from 'vitest';

import { createPreToolUseHook, type PdpBroker, type PreToolUsePorts } from './pre-tool-use.js';

/** The options a Gate 2 `POST` carries: the idempotency key. */
type PostOptions = { readonly idempotencyKey?: string } | undefined;

const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8057';
const SESSION = '01920000-0000-7000-8000-000000000003';
const EXCEPTION = '01920000-0000-7000-8000-00000000000a';
const CONTEXT = {
  sessionId: SESSION,
  subtaskId: SUBTASK,
  testCaseId: null,
  roleId: 'auth-specialist',
};
const hookInput = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'toolu_1',
  session_id: 'sess',
});

interface Harness {
  readonly calls: { suffix: string; body: unknown; options: PostOptions }[];
  readonly decided: { decision: string; reason: string }[];
  readonly latencies: number[];
  readonly logs: Readonly<Record<string, string>>[];
  readonly gate2: { defers: number; batchDenies: number };
  readonly ports: PreToolUsePorts;
}

function harness(
  answer: (suffix: string, body: unknown) => Promise<unknown>,
  timeoutMs = 1500,
): Harness {
  const calls: { suffix: string; body: unknown; options: PostOptions }[] = [];
  const decided: { decision: string; reason: string }[] = [];
  const latencies: number[] = [];
  const logs: Readonly<Record<string, string>>[] = [];
  const gate2 = { defers: 0, batchDenies: 0 };
  const broker: PdpBroker = {
    post: (async (
      suffix: string,
      body: unknown,
      schema: { parse: (v: unknown) => unknown },
      options?: PostOptions,
    ) => {
      calls.push({ suffix, body, options });
      return schema.parse(await answer(suffix, body));
    }) as PdpBroker['post'],
  };
  return {
    calls,
    decided,
    latencies,
    logs,
    gate2,
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
        gate2Deferred: () => {
          gate2.defers += 1;
        },
        gate2BatchDenied: () => {
          gate2.batchDenies += 1;
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
    await createPreToolUseHook(h.ports, {
      sessionId: SESSION,
      subtaskId: null,
      testCaseId: null,
      roleId: null,
    })(
      hookInput('mcp__recon__probe', {
        url: 'https://lab.example.test/a?secret=1',
        body: 'PAYLOAD',
      }),
    );
    expect(JSON.stringify(h.calls[0]?.body)).not.toContain('PAYLOAD');
    expect(JSON.stringify(h.calls[0]?.body)).not.toContain('secret=1');
  });
});

const EXCEPTION_ANSWER = {
  decision: 'exception',
  reason: 'out_of_scope',
  intrusiveness: 'active_safe',
};
const exception = () => Promise.resolve(EXCEPTION_ANSWER);
/** The Gate 2 answer: an exception row in `state`, created or replayed. */
const gate2Row = (state: string) => (suffix: string) =>
  suffix === 'gate2/exceptions' ? Promise.resolve({ exceptionId: EXCEPTION, state }) : allow();
const scopeCall = hookInput('Bash', { command: 'curl https://other.example.test/' });
const gateCalls = (h: Harness) => h.calls.filter((c) => c.suffix === 'gate2/exceptions');

describe('PreToolUse Gate 2 exceptions (RUNTIME-006)', () => {
  it('defers a single out-of-envelope call and opens one Gate 2 exception for it', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row('pending')(suffix),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        permissionDecisionReason: 'out_of_scope',
      },
    });
    expect(gateCalls(h)).toHaveLength(1);
    expect(gateCalls(h)[0]?.body).toEqual({
      sessionId: SESSION,
      subtaskId: SUBTASK,
      testCaseId: null,
      toolName: 'Bash',
      proposedActionSummary: 'out_of_scope: Bash https://other.example.test/',
      envelopeReason: 'out_of_scope',
      intrusiveness: 'active_safe',
      batch: false,
    });
    expect(h.gate2.defers).toBe(1);
  });

  it('sends a deterministic Idempotency-Key per session and tool use, so a retry repeats it', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row('pending')(suffix),
    );
    const hook = createPreToolUseHook(h.ports, CONTEXT);
    await hook(scopeCall);
    await hook(scopeCall);
    const [first, second] = gateCalls(h);
    expect(first?.options?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.options?.idempotencyKey).toBe(first?.options?.idempotencyKey);
    const other = await createPreToolUseHook(
      h.ports,
      CONTEXT,
    )({
      ...scopeCall,
      tool_use_id: 'toolu_2',
    });
    expect(other.hookSpecificOutput.permissionDecision).toBe('defer');
    expect(gateCalls(h)[2]?.options?.idempotencyKey).not.toBe(first?.options?.idempotencyKey);
  });

  it('logs the deferral with the exception id and session id, never the call input', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row('pending')(suffix),
    );
    await createPreToolUseHook(
      h.ports,
      CONTEXT,
    )(hookInput('Bash', { command: 'curl https://other.example.test/?token=hunter2-SECRET' }));
    expect(h.logs).toContainEqual({
      toolName: 'Bash',
      decision: 'defer',
      reason: 'out_of_scope',
      exceptionId: EXCEPTION,
      sessionId: SESSION,
    });
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
    expect(JSON.stringify(h.calls)).not.toContain('hunter2');
  });

  it('denies a batched out-of-envelope call with batch_out_of_envelope_paused and never defers', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row('pending')(suffix),
    );
    const hook = createPreToolUseHook(h.ports, CONTEXT);
    const [first, second] = await Promise.all([
      hook(hookInput('Bash', { command: 'curl https://other.example.test/a' })),
      hook({
        ...hookInput('Bash', { command: 'curl https://other.example.test/b' }),
        tool_use_id: 'toolu_2',
      }),
    ]);
    for (const out of [first, second]) {
      expect(out.hookSpecificOutput).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: 'batch_out_of_envelope_paused',
      });
    }
    expect(gateCalls(h)).toHaveLength(0);
    expect(h.gate2).toEqual({ defers: 0, batchDenies: 2 });
  });

  it('treats a lone call after a batch as a single call again', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row('pending')(suffix),
    );
    const hook = createPreToolUseHook(h.ports, CONTEXT);
    await Promise.all([hook(scopeCall), hook(scopeCall)]);
    const out = await hook(scopeCall);
    expect(out.hookSpecificOutput.permissionDecision).toBe('defer');
  });

  it('never defers a destructive call: the PDP denies it and no exception is opened', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate'
        ? Promise.resolve({ decision: 'deny', reason: 'destructive_class' })
        : gate2Row('pending')(suffix),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'destructive_class',
    });
    expect(gateCalls(h)).toHaveLength(0);
  });

  it('denies with gate2_exception_unavailable when the exception cannot be recorded, never defer', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate'
        ? exception()
        : Promise.reject(new Error('503 TEMPORAL_UNAVAILABLE')),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'gate2_exception_unavailable',
    });
    expect(h.gate2.defers).toBe(0);
  });

  it('denies with gate2_exception_unavailable when the exception answer is malformed', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate'
        ? exception()
        : Promise.resolve({ exceptionId: 'x', state: 'approved' }),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'gate2_exception_unavailable',
    });
  });

  it('denies without recording when the PDP does not state the exception class', async () => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate'
        ? Promise.resolve({ decision: 'exception', reason: 'out_of_scope' })
        : gate2Row('pending')(suffix),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('gate2_exception_unavailable');
    expect(gateCalls(h)).toHaveLength(0);
  });

  it.each([
    ['denied', 'gate2_denied'],
    ['timed_out', 'gate2_denied'],
    ['superseded', 'gate2_denied'],
    ['approved_once', 'gate2_resume_required'],
  ])('answers a stored %s exception with %s, never allow', async (state, reason) => {
    const h = harness((suffix) =>
      suffix === 'pdp/evaluate' ? exception() : gate2Row(state)(suffix),
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(reason);
  });

  it('denies with pdp_timeout-bounded gate2_exception_unavailable when recording does not answer in time', async () => {
    const h = harness(
      (suffix) => (suffix === 'pdp/evaluate' ? exception() : new Promise<never>(() => undefined)),
      5,
    );
    const out = await createPreToolUseHook(h.ports, CONTEXT)(scopeCall);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('gate2_exception_unavailable');
  });
});
