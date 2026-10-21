import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createAgentSessionActivities, type AgentSessionActivityDeps } from './activities.js';
import { INPUT, RUN_OK } from './testing.js';

import type { CostLedgerEntry } from './ports.js';
import type { RunSessionRequest } from './types.js';

const RAW_KEY = 'bwk_live_0123456789abcdef0123456789abcdef';

const RUN_REQUEST: RunSessionRequest = {
  ...INPUT,
  sessionRef: 'ses_1',
  sandboxId: 'sbx_1',
  workspaceDir: '/workspace',
  caRef: 'openbao://ca/1',
  keyRef: 'ref://vk_1',
};

function setup(overrides: Partial<AgentSessionActivityDeps> = {}) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const abort = new AbortController();
  const heartbeat = vi.fn();
  const ledger: CostLedgerEntry[] = [];
  const sessionFinished = vi.fn();
  const sandboxProvisioned = vi.fn();
  const sandboxTornDown = vi.fn();
  const scheduleOrphanTeardown = vi.fn(() => Promise.resolve());
  const teardownFailed = vi.fn(() => Promise.resolve());
  let clock = 0;
  const deps: AgentSessionActivityDeps = {
    sandboxes: {
      provision: () =>
        Promise.resolve({ sandboxId: 'sbx_1', workspaceDir: '/workspace', caRef: 'ref://ca' }),
      destroy: () => Promise.resolve(),
      scheduleOrphanTeardown,
    },
    keys: {
      issue: () => Promise.resolve({ keyId: 'vk_1', keyRef: 'ref://vk_1' }),
      revoke: () => Promise.resolve(),
    },
    runtime: { run: () => Promise.resolve(RUN_OK) },
    evidence: { flush: () => Promise.resolve() },
    sessions: { start: () => Promise.resolve(), finish: () => Promise.resolve() },
    cost: {
      record: (entries) => {
        ledger.push(...entries);
        return Promise.resolve();
      },
    },
    coverage: { recordDeclined: () => Promise.resolve() },
    audit: { emit: () => Promise.resolve() },
    alerts: { teardownFailed },
    metrics: { sessionFinished, sandboxProvisioned, sandboxTornDown },
    log: createLogger('agent-session-test', { destination }),
    context: () => ({ cancellationSignal: abort.signal, heartbeat }),
    now: () => (clock += 2000),
    ...overrides,
  };
  return {
    acts: createAgentSessionActivities(deps),
    lines,
    abort,
    heartbeat,
    ledger,
    sessionFinished,
    sandboxProvisioned,
    sandboxTornDown,
    scheduleOrphanTeardown,
    teardownFailed,
  };
}

describe('agent session activities', () => {
  it('runs the session, validates and returns the result', async () => {
    const { acts } = setup();
    expect(await acts.runAgentSession(RUN_REQUEST)).toEqual(RUN_OK);
  });

  it('drops the free-text result field so it never reaches workflow history', async () => {
    const { acts } = setup({
      runtime: {
        run: () =>
          Promise.resolve({
            ...RUN_OK,
            result: { ...RUN_OK.result, result: 'secret finding text' },
          }),
      },
    });
    const out = await acts.runAgentSession(RUN_REQUEST);
    expect(JSON.stringify(out)).not.toContain('secret finding text');
  });

  it('fails closed on a malformed runtime answer', async () => {
    const { acts } = setup({
      runtime: { run: () => Promise.resolve({ result: { subtype: 'success' } }) },
    });
    await expect(acts.runAgentSession(RUN_REQUEST)).rejects.toThrow();
  });

  it('rejects pins that are not a sha256 digest', async () => {
    const { acts } = setup({
      runtime: {
        run: () =>
          Promise.resolve({ ...RUN_OK, pins: { ...RUN_OK.pins, promptSha256: 'not-a-hash' } }),
      },
    });
    await expect(acts.runAgentSession(RUN_REQUEST)).rejects.toThrow();
  });

  it('forwards heartbeats from the runtime to Temporal', async () => {
    const { acts, heartbeat } = setup({
      runtime: {
        run: (_req, _signal, beat) => {
          beat({ turns: 3, costUsd: 0.1 });
          return Promise.resolve(RUN_OK);
        },
      },
    });
    await acts.runAgentSession(RUN_REQUEST);
    expect(heartbeat).toHaveBeenCalledWith({ turns: 3, costUsd: 0.1 });
  });

  it('aborts the SDK through its abort signal when the activity is cancelled', async () => {
    let seen: AbortSignal | undefined;
    const ctrl = new AbortController();
    const { acts } = setup({
      context: () => ({ cancellationSignal: ctrl.signal, heartbeat: vi.fn() }),
      runtime: {
        run: (_req, signal) => {
          seen = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          });
        },
      },
    });
    const pending = acts.runAgentSession(RUN_REQUEST);
    expect(seen?.aborted).toBe(false);
    ctrl.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('aborts immediately when the activity was already cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let aborted = false;
    const { acts } = setup({
      context: () => ({ cancellationSignal: ctrl.signal, heartbeat: vi.fn() }),
      runtime: {
        run: (_req, signal) => {
          aborted = signal.aborted;
          return Promise.resolve(RUN_OK);
        },
      },
    });
    await acts.runAgentSession(RUN_REQUEST);
    expect(aborted).toBe(true);
  });

  it('never logs the virtual key, even if an adapter error carries it', async () => {
    const { acts, lines } = setup({
      runtime: { run: () => Promise.reject(new Error(`gateway rejected ${RAW_KEY}`)) },
      keys: {
        issue: () => Promise.resolve({ keyId: 'vk_1', keyRef: 'ref://vk_1' }),
        revoke: () => Promise.resolve(),
      },
    });
    await acts.issueVirtualKey({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      model: 'm',
      maxBudgetUsd: 1,
      ttlMs: 1000,
    });
    await acts.revokeVirtualKey({ tenantId: 't', runId: 'r', sessionRef: 's', keyId: 'vk_1' });
    await acts.reportTeardownFailure({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      kind: 'virtual_key',
      resourceId: 'vk_1',
      error: `revoke failed for ${RAW_KEY}`,
    });
    await expect(acts.runAgentSession(RUN_REQUEST)).rejects.toThrow();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(RAW_KEY);
    expect(lines.join('')).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('logs the §Observability fields on session end', async () => {
    const { acts, lines } = setup();
    await acts.runAgentSession(RUN_REQUEST);
    const entry = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      runId: 'run_1',
      sessionId: 'sess_abc',
      persona: 'web-api-specialist',
      sandboxId: 'sbx_1',
      subtype: 'success',
      num_turns: 7,
      total_cost_usd: 0.42,
    });
  });

  it('records provision and teardown durations', async () => {
    const { acts, sandboxProvisioned, sandboxTornDown } = setup();
    await acts.provisionSandbox({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      persona: 'p',
      egressIdentity: 'run:r',
      differentNode: false,
    });
    await acts.destroySandbox({ tenantId: 't', runId: 'r', sessionRef: 's', sandboxId: 'sbx_1' });
    expect(sandboxProvisioned).toHaveBeenCalledWith(2);
    expect(sandboxTornDown).toHaveBeenCalledWith(2);
  });

  it('books cost from modelUsage into the ledger', async () => {
    const { acts, ledger } = setup();
    await acts.recordSessionCost({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      persona: 'p',
      result: RUN_OK.result,
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ tenantId: 't', model: 'claude-sonnet-5-5' });
  });

  it('emits the session metric with persona and subtype', async () => {
    const { acts, sessionFinished } = setup();
    await acts.recordSessionFinish({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      persona: 'web-api-specialist',
      subtype: 'error_max_turns',
      pins: RUN_OK.pins,
      sessionId: 'sess_abc',
      numTurns: 7,
      totalCostUsd: 0.42,
      modelUsage: RUN_OK.result.modelUsage,
      transcriptKey: null,
      subtask: { status: 'blocked', reason: 'error_max_turns', declined: false },
    });
    expect(sessionFinished).toHaveBeenCalledWith('web-api-specialist', 'error_max_turns', 0.42);
  });

  it('alerts and schedules the out-of-band retry for an orphaned sandbox', async () => {
    const { acts, teardownFailed, scheduleOrphanTeardown, lines } = setup();
    const request = {
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      kind: 'sandbox' as const,
      resourceId: 'sbx_1',
      error: 'node unreachable',
    };
    await acts.reportTeardownFailure(request);
    expect(teardownFailed).toHaveBeenCalledWith(request);
    expect(scheduleOrphanTeardown).toHaveBeenCalledWith(request);
    expect(lines.join('')).toContain('sandbox.orphaned');
  });

  it('alerts but does not queue a sandbox retry for a key revocation failure', async () => {
    const { acts, teardownFailed, scheduleOrphanTeardown } = setup();
    await acts.reportTeardownFailure({
      tenantId: 't',
      runId: 'r',
      sessionRef: 's',
      kind: 'virtual_key',
      resourceId: 'vk_1',
      error: 'x',
    });
    expect(teardownFailed).toHaveBeenCalledTimes(1);
    expect(scheduleOrphanTeardown).not.toHaveBeenCalled();
  });
});
