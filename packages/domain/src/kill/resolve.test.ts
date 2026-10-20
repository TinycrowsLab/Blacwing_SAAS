// Kill scope resolver (KILL-002): scope widening, terminal filtering, de-dup, tenant isolation and the
// operator-versus-tenant context guard. The reader is an in-memory fake that, like the real adapter,
// may over-fetch; tests also feed it rows a broken RLS adapter would leak to prove the resolver drops them.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  killTargetSetSchema,
  PLATFORM_OPERATOR,
  type RunState,
  runStateSchema,
  TERMINAL_RUN_STATES,
} from '@blackwing/contracts';
import { isAppError } from '@blackwing/errors';

import * as domain from '../index.js';
import {
  emptyKillTargetSet,
  isKillableRunState,
  KILL_RESOLVE_REASONS,
  KILL_RESOLVE_SPAN,
  type KillResolveContext,
  KillResolveError,
  type KillRunQuery,
  type KillRunRow,
  type KillSessionRow,
  type KillSubtaskRow,
  type KillTargetReader,
  proxyPrincipal,
  resolveKillTargets,
} from './resolve.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const TENANT_A = ID(0xa);
const TENANT_B = ID(0xb);
const ASSET_1 = ID(0x100);
const ASSET_2 = ID(0x200);
const ASSET_B = ID(0x300);

const tenantCtx = (tenantId: string): KillResolveContext => ({ kind: 'tenant', tenantId });
const operatorCtx: KillResolveContext = {
  kind: 'operator',
  role: PLATFORM_OPERATOR,
  operatorId: 'op-1',
};

interface Fixture {
  readonly runs: readonly KillRunRow[];
  readonly sessions?: readonly KillSessionRow[];
  readonly subtasks?: readonly KillSubtaskRow[];
}

interface FakeReader extends KillTargetReader {
  readonly calls: { runs: KillRunQuery[]; sessions: number };
}

/**
 * In-memory reader. `rls: true` emulates `withTenant` (rows of other tenants are invisible); `false`
 * emulates a broken adapter that returns everything, to prove the resolver's own tenancy check.
 * It ignores `excludeStates` on purpose (over-fetching is allowed by the port contract).
 */
function reader(context: KillResolveContext, fx: Fixture, rls = true): FakeReader {
  const visible = <T extends { readonly tenantId: string }>(rows: readonly T[]): T[] =>
    rows.filter((r) => !rls || context.kind === 'operator' || r.tenantId === context.tenantId);
  const calls = { runs: [] as KillRunQuery[], sessions: 0 };
  return {
    context,
    calls,
    listRuns(query) {
      calls.runs.push(query);
      return Promise.resolve(visible(fx.runs));
    },
    listSessions(runIds) {
      calls.sessions += 1;
      return Promise.resolve(visible(fx.sessions ?? []).filter((s) => runIds.includes(s.runId)));
    },
    listSubtasks(runIds) {
      return Promise.resolve(visible(fx.subtasks ?? []).filter((s) => runIds.includes(s.runId)));
    },
  };
}

const run = (
  n: number,
  over: Partial<KillRunRow> & Pick<KillRunRow, 'tenantId'> = { tenantId: TENANT_A },
): KillRunRow => ({
  id: ID(n),
  state: 'executing',
  assetIds: [ASSET_1],
  workflowId: `run-wf-${n.toString()}`,
  ...over,
});

const session = (runN: number, s: string, over: Partial<KillSessionRow> = {}): KillSessionRow => ({
  tenantId: TENANT_A,
  runId: ID(runN),
  sessionId: s,
  sandboxId: `sbx-${s}`,
  virtualKeyId: `vk-${s}`,
  workflowId: `sess-wf-${s}`,
  testCaseId: `0190aaaa-0000-7000-8000-00000000000${s.length.toString()}`,
  roleId: 'r1',
  ...over,
});

async function expectRejection(promise: Promise<unknown>, reason: string, code: string) {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(KillResolveError);
  expect(isAppError(err)).toBe(true);
  expect(err).toMatchObject({ reason, code });
}

describe('resolveKillTargets: scopes (KILL-002)', () => {
  const fx: Fixture = {
    runs: [
      run(1, { tenantId: TENANT_A, assetIds: [ASSET_1] }),
      run(2, { tenantId: TENANT_A, assetIds: [ASSET_1, ASSET_2], state: 'paused' }),
      run(3, { tenantId: TENANT_A, assetIds: [ASSET_2], state: 'awaiting_gate1' }),
      run(4, { tenantId: TENANT_A, assetIds: [ASSET_1], state: 'completed' }),
      run(5, { tenantId: TENANT_B, assetIds: [ASSET_B] }),
    ],
    sessions: [
      session(1, 's1', { testCaseId: 'tc1', roleId: 'admin' }),
      session(2, 's2', { virtualKeyId: null, testCaseId: null }),
      session(4, 's4'),
      session(5, 's5', { tenantId: TENANT_B }),
    ],
    subtasks: [{ tenantId: TENANT_A, runId: ID(3), sessionId: 's3-pending', sandboxId: 'sbx-s3' }],
  };

  it('run scope returns that run with its sessions, sandboxes, keys, identities and workflows', async () => {
    const set = await resolveKillTargets('run', ID(1), reader(tenantCtx(TENANT_A), fx));
    expect(set).toEqual({
      runIds: [ID(1)],
      sessionIds: ['s1'],
      sandboxIds: ['sbx-s1'],
      virtualKeyIds: ['vk-s1'],
      egressIdentities: [
        { kind: 'run', runId: ID(1) },
        { kind: 'proxy_principal', runId: ID(1), sessionId: 's1', principal: 'tc_tc1.role_admin' },
      ],
      workflowIds: ['run-wf-1', 'sess-wf-s1'],
    });
    expect(killTargetSetSchema.parse(set)).toEqual(set);
  });

  it('asset scope widens to every non-terminal run targeting the asset, paused included', async () => {
    const set = await resolveKillTargets('asset', ASSET_1, reader(tenantCtx(TENANT_A), fx));
    expect(set.runIds).toEqual([ID(1), ID(2)]);
    expect(set.sessionIds).toEqual(['s1', 's2']);
    expect(set.virtualKeyIds).toEqual(['vk-s1']);
    // s2 has no test case, so only its run identity covers it.
    expect(set.egressIdentities.filter((e) => e.kind === 'proxy_principal')).toHaveLength(1);
  });

  it('tenant scope returns every non-terminal run of the tenant, awaiting_gate* included', async () => {
    const set = await resolveKillTargets('tenant', null, reader(tenantCtx(TENANT_A), fx));
    expect(set.runIds).toEqual([ID(1), ID(2), ID(3)]);
    // The subtask names a session/sandbox whose agent_sessions row is not written yet.
    expect(set.sessionIds).toEqual(['s1', 's2', 's3-pending']);
    expect(set.sandboxIds).toEqual(['sbx-s1', 'sbx-s2', 'sbx-s3']);
    expect(set.workflowIds).toEqual([
      'run-wf-1',
      'run-wf-2',
      'run-wf-3',
      'sess-wf-s1',
      'sess-wf-s2',
    ]);
  });

  it('tenant scope accepts the tenant naming itself and refuses another tenant', async () => {
    const own = await resolveKillTargets('tenant', TENANT_A, reader(tenantCtx(TENANT_A), fx));
    expect(own.runIds).toEqual([ID(1), ID(2), ID(3)]);
    await expectRejection(
      resolveKillTargets('tenant', TENANT_B, reader(tenantCtx(TENANT_A), fx)),
      KILL_RESOLVE_REASONS.crossTenant,
      'FORBIDDEN',
    );
  });

  it('operator tenant scope needs the tenant id and returns only that tenant', async () => {
    const set = await resolveKillTargets('tenant', TENANT_B, reader(operatorCtx, fx));
    expect(set.runIds).toEqual([ID(5)]);
    expect(set.sessionIds).toEqual(['s5']);
    await expectRejection(
      resolveKillTargets('tenant', null, reader(operatorCtx, fx)),
      KILL_RESOLVE_REASONS.invalidRef,
      'VALIDATION_FAILED',
    );
  });

  it('global scope returns every non-terminal run across tenants in the operator context', async () => {
    const set = await resolveKillTargets('global', null, reader(operatorCtx, fx));
    expect(set.runIds).toEqual([ID(1), ID(2), ID(3), ID(5)]);
    expect(set.sessionIds).toEqual(['s1', 's2', 's3-pending', 's5']);
    await expectRejection(
      resolveKillTargets('global', ID(1), reader(operatorCtx, fx)),
      KILL_RESOLVE_REASONS.invalidRef,
      'VALIDATION_FAILED',
    );
  });

  it.each([
    ['run', ID(99)],
    ['asset', ID(98)],
    ['tenant', null],
    ['global', null],
  ] as const)('%s scope with no matching runs returns the empty set', async (scope, ref) => {
    const ctx = scope === 'global' ? operatorCtx : tenantCtx(TENANT_A);
    const r = reader(ctx, { runs: [] });
    const set = await resolveKillTargets(scope, ref, r);
    expect(set).toEqual(emptyKillTargetSet());
    expect(killTargetSetSchema.parse(set)).toEqual(set);
    // Nothing matched, so no session lookups follow.
    expect(r.calls.sessions).toBe(0);
  });

  it('a run that is already terminal resolves to the empty set', async () => {
    const set = await resolveKillTargets('run', ID(4), reader(tenantCtx(TENANT_A), fx));
    expect(set).toEqual(emptyKillTargetSet());
  });

  it('passes the terminal states and the scope query to the reader', async () => {
    const r = reader(tenantCtx(TENANT_A), fx);
    await resolveKillTargets('asset', ASSET_2, r);
    expect(r.calls.runs).toEqual([{ by: 'asset', assetId: ASSET_2 }]);
  });

  it.each([
    ['run', null],
    ['run', 'not-a-uuid'],
    ['asset', null],
    ['asset', 'ASSET'],
  ] as const)('%s scope with ref %s is a validation error', async (scope, ref) => {
    expect.assertions(3);
    await expectRejection(
      resolveKillTargets(scope, ref, reader(tenantCtx(TENANT_A), fx)),
      KILL_RESOLVE_REASONS.invalidRef,
      'VALIDATION_FAILED',
    );
  });

  it('refuses an unknown scope and an invalid context', async () => {
    await expect(
      resolveKillTargets('fleet' as never, null, reader(tenantCtx(TENANT_A), fx)),
    ).rejects.toThrow();
    await expectRejection(
      resolveKillTargets('tenant', null, reader(tenantCtx('acme'), fx)),
      KILL_RESOLVE_REASONS.invalidContext,
      'FORBIDDEN',
    );
    const fakeOperator = { kind: 'operator', role: 'tenant_admin', operatorId: 'x' } as never;
    await expectRejection(
      resolveKillTargets('global', null, reader(fakeOperator, fx)),
      KILL_RESOLVE_REASONS.invalidContext,
      'FORBIDDEN',
    );
  });
});

describe('resolveKillTargets: operator context guard', () => {
  it('kill.resolve.globalRequiresOperator', async () => {
    const r = reader(tenantCtx(TENANT_A), { runs: [run(1)] });
    await expectRejection(
      resolveKillTargets('global', null, r),
      KILL_RESOLVE_REASONS.globalRequiresOperator,
      'FORBIDDEN',
    );
    // Refused before any row is read.
    expect(r.calls.runs).toEqual([]);
    expect(KILL_RESOLVE_REASONS.globalRequiresOperator).toBe('kill.resolve.globalRequiresOperator');
  });
});

describe('resolveKillTargets: tenant isolation (§8.6)', () => {
  const fx: Fixture = {
    runs: [
      run(1, { tenantId: TENANT_A, assetIds: [ASSET_1] }),
      run(5, { tenantId: TENANT_B, assetIds: [ASSET_B] }),
      // Same asset id in another tenant: must never widen a tenant-A asset kill.
      run(6, { tenantId: TENANT_B, assetIds: [ASSET_1] }),
    ],
    sessions: [
      session(1, 's1'),
      session(5, 's5', { tenantId: TENANT_B }),
      // A row claiming tenant B on a tenant-A run (corrupt join): dropped.
      session(1, 'sx', { tenantId: TENANT_B }),
    ],
    subtasks: [{ tenantId: TENANT_B, runId: ID(1), sessionId: 'sy', sandboxId: 'sbx-sy' }],
  };

  it.each([true, false])(
    'an asset of another tenant is not returned (adapter RLS on: %s)',
    async (rls) => {
      const own = await resolveKillTargets('asset', ASSET_B, reader(tenantCtx(TENANT_A), fx, rls));
      expect(own).toEqual(emptyKillTargetSet());
      const shared = await resolveKillTargets(
        'asset',
        ASSET_1,
        reader(tenantCtx(TENANT_A), fx, rls),
      );
      expect(shared.runIds).toEqual([ID(1)]);
      expect(shared.sessionIds).toEqual(['s1']);
      expect(shared.sandboxIds).toEqual(['sbx-s1']);
    },
  );

  it('a run of another tenant is not returned even by a leaky adapter', async () => {
    const set = await resolveKillTargets('run', ID(5), reader(tenantCtx(TENANT_A), fx, false));
    expect(set).toEqual(emptyKillTargetSet());
  });

  it('tenant scope never crosses tenants', async () => {
    const set = await resolveKillTargets('tenant', null, reader(tenantCtx(TENANT_B), fx, false));
    expect(set.runIds).toEqual([ID(5), ID(6)]);
    expect(set.sessionIds).toEqual(['s5']);
  });
});

describe('resolveKillTargets: de-duplication', () => {
  it('de-duplicates sessions retried with the same session_id', async () => {
    const fx: Fixture = {
      runs: [run(1), run(1)],
      sessions: [
        session(1, 's1', { testCaseId: 'tc1', roleId: 'r1' }),
        session(1, 's1', { testCaseId: 'tc1', roleId: 'r1' }),
        session(1, 's1', {
          sandboxId: 'sbx-retry',
          virtualKeyId: 'vk-retry',
          testCaseId: 'tc1',
          roleId: 'r1',
        }),
      ],
      subtasks: [{ tenantId: TENANT_A, runId: ID(1), sessionId: 's1', sandboxId: 'sbx-s1' }],
    };
    const set = await resolveKillTargets('run', ID(1), reader(tenantCtx(TENANT_A), fx));
    expect(set.runIds).toEqual([ID(1)]);
    expect(set.sessionIds).toEqual(['s1']);
    // A retry in a fresh sandbox with a fresh key: both sandboxes and both keys must be stopped.
    expect(set.sandboxIds).toEqual(['sbx-retry', 'sbx-s1']);
    expect(set.virtualKeyIds).toEqual(['vk-retry', 'vk-s1']);
    expect(set.workflowIds).toEqual(['run-wf-1', 'sess-wf-s1']);
    expect(set.egressIdentities).toEqual([
      { kind: 'run', runId: ID(1) },
      { kind: 'proxy_principal', runId: ID(1), sessionId: 's1', principal: 'tc_tc1.role_r1' },
    ]);
  });
});

describe('resolveKillTargets: properties', () => {
  const stateArb = fc.constantFrom(...runStateSchema.options);
  const runsArb = fc
    .array(
      fc.record({
        n: fc.integer({ min: 1, max: 40 }),
        state: stateArb,
        tenant: fc.constantFrom(TENANT_A, TENANT_B),
        asset: fc.constantFrom(ASSET_1, ASSET_2),
      }),
      { maxLength: 30 },
    )
    .map((rows) =>
      rows.map((r): KillRunRow => ({
        id: ID(r.n),
        tenantId: r.tenant,
        state: r.state,
        assetIds: [r.asset],
        workflowId: null,
      })),
    );

  it('terminal-state runs are never returned, every non-terminal match is', async () => {
    await fc.assert(
      fc.asyncProperty(runsArb, async (runs) => {
        const set = await resolveKillTargets('global', null, reader(operatorCtx, { runs }));
        const expected = [
          ...new Set(runs.filter((r) => !TERMINAL_RUN_STATES.includes(r.state)).map((r) => r.id)),
        ].sort();
        expect(set.runIds).toEqual(expected);
        // Ids that only ever appear in a terminal state are absent.
        const terminalOnly = runs
          .filter((r) => TERMINAL_RUN_STATES.includes(r.state))
          .map((r) => r.id)
          .filter((id) => !expected.includes(id));
        expect(set.runIds.filter((id) => terminalOnly.includes(id))).toEqual([]);
      }),
    );
  });

  it('scope widening is monotone: run ⊆ asset ⊆ tenant ⊆ global', async () => {
    await fc.assert(
      fc.asyncProperty(runsArb, fc.integer({ min: 1, max: 40 }), async (runs, pick) => {
        const tenantA = tenantCtx(TENANT_A);
        const byRun = await resolveKillTargets('run', ID(pick), reader(tenantA, { runs }));
        const byAsset = await resolveKillTargets('asset', ASSET_1, reader(tenantA, { runs }));
        const byTenant = await resolveKillTargets('tenant', null, reader(tenantA, { runs }));
        const all = await resolveKillTargets('global', null, reader(operatorCtx, { runs }));
        const subset = (a: string[], b: string[]) => a.every((x) => b.includes(x));
        expect(subset(byAsset.runIds, byTenant.runIds)).toBe(true);
        expect(subset(byRun.runIds, byTenant.runIds)).toBe(true);
        expect(subset(byTenant.runIds, all.runIds)).toBe(true);
        for (const id of byTenant.runIds) {
          expect(runs.some((r) => r.id === id && r.tenantId === TENANT_A)).toBe(true);
        }
      }),
    );
  });

  it('is deterministic: input order does not change the result', async () => {
    await fc.assert(
      fc.asyncProperty(runsArb, async (runs) => {
        const a = await resolveKillTargets('global', null, reader(operatorCtx, { runs }));
        const b = await resolveKillTargets(
          'global',
          null,
          reader(operatorCtx, { runs: [...runs].reverse() }),
        );
        expect(b).toEqual(a);
      }),
    );
  });
});

describe('kill helpers', () => {
  it('isKillableRunState matches §3.3: paused and awaiting_gate* are killable', () => {
    const killable = runStateSchema.options.filter((s: RunState) => isKillableRunState(s));
    expect(killable).toContain('paused');
    expect(killable).toContain('awaiting_gate1');
    expect(killable).toContain('awaiting_gate3');
    for (const s of ['cancelled', 'killed', 'failed', 'expired', 'completed'] as const) {
      expect(isKillableRunState(s)).toBe(false);
    }
  });

  it('proxyPrincipal encodes test case and role', () => {
    expect(proxyPrincipal('abc', 'r9')).toBe('tc_abc.role_r9');
  });

  it('exposes the caller span name and is exported from the package root', () => {
    expect(KILL_RESOLVE_SPAN).toBe('kill.resolve');
    expect(domain.resolveKillTargets).toBe(resolveKillTargets);
    expect(domain.KillResolveError).toBe(KillResolveError);
  });
});
