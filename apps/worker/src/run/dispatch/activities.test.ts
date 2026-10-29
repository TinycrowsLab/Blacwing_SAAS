import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createDispatchActivities, egressIdentityFor } from './activities.js';

import type {
  DispatchAuditRecord,
  DispatchTestCase,
  PersonaProfile,
  SlotOutcome,
  SubtaskRow,
} from './ports.js';
import type { DispatchOutcome } from './types.js';

const T = '0190a1b2-c3d4-7e5f-8a6b-000000000001';
const R = '0190a1b2-c3d4-7e5f-8a6b-000000000002';
const TC = '0190a1b2-c3d4-7e5f-8a6b-000000000003';
const SUB = '0190a1b2-c3d4-7e5f-8a6b-000000000004';
const ref = { tenantId: T, runId: R };

const brief = {
  targets: ['https://app.example.com/graphql'],
  role: 'admin',
  class: 'active_safe',
  oracle: { type: 'status_diff', params: {} },
  negativeControl: { type: 'status_diff', params: {} },
  budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
  standardRefs: { wstg: ['WSTG-APIT-01'], cwe: ['CWE-89'], owasp: ['A03'] },
};
const request = { subtaskId: SUB, testCaseId: TC, persona: 'web-api-specialist', brief };

const WEB_API: PersonaProfile = {
  name: 'web-api-specialist',
  version: '1.0.0',
  mandate: 'Detect injection (CWE-89, WSTG-INPV-05), GraphQL (WSTG-APIT).',
  intrusivenessCeiling: 'state_changing',
  model: 'm',
  effort: 'high',
  maxTurns: 10,
  maxBudgetUsd: 1,
};
const INFRA: PersonaProfile = {
  ...WEB_API,
  name: 'infrastructure-specialist',
  mandate: 'Configuration (A05, WSTG-CONF).',
};

function setup(
  opts: {
    state?: string;
    testCase?: Partial<DispatchTestCase> | null;
    journal?: boolean;
    slot?: SlotOutcome;
  } = {},
) {
  const rows = new Map<string, SubtaskRow>();
  const audit: DispatchAuditRecord[] = [];
  const insert = vi.fn(
    (
      _t: string,
      _r: string,
      row: Omit<SubtaskRow, 'status' | 'sessionId' | 'sandboxId' | 'result' | 'costUsd'>,
    ) => {
      const existing = rows.get(row.subtaskId);
      if (existing !== undefined) return Promise.resolve({ row: existing, created: false });
      const created: SubtaskRow = {
        ...row,
        status: 'dispatched',
        sessionId: null,
        sandboxId: null,
        result: null,
        costUsd: 0,
      };
      rows.set(row.subtaskId, created);
      return Promise.resolve({ row: created, created: true });
    },
  );
  const slots = {
    acquire: vi.fn(() => Promise.resolve(opts.slot ?? 'acquired')),
    release: vi.fn(() => Promise.resolve()),
  };
  const metrics = { subtask: vi.fn(), rejection: vi.fn() };
  const deps = {
    runs: {
      load: () =>
        Promise.resolve({
          status: { state: opts.state ?? 'executing', version: 1 },
          requestedBy: null,
          envelopeValid: true,
        } as never),
    },
    personas: {
      lookup: (n: string) => (n === WEB_API.name ? WEB_API : n === INFRA.name ? INFRA : null),
    },
    testCases: {
      get: () =>
        Promise.resolve(
          opts.testCase === null
            ? null
            : {
                id: TC,
                class: 'active_safe',
                status: 'approved',
                owasp: ['A03'],
                wstg: ['WSTG-APIT-01'],
                cwe: ['CWE-89'],
                ...opts.testCase,
              },
        ),
    },
    journal: { hasPreEntry: vi.fn(() => Promise.resolve(opts.journal ?? false)) },
    subtasks: {
      insert,
      get: (_t: string, _r: string, id: string) => Promise.resolve(rows.get(id) ?? null),
      transition: (
        _t: string,
        _r: string,
        id: string,
        from: readonly string[],
        next: Partial<SubtaskRow>,
      ) => {
        const row = rows.get(id);
        if (row === undefined || !from.includes(row.status)) return Promise.resolve(false);
        rows.set(id, { ...row, ...next });
        return Promise.resolve(true);
      },
    },
    slots,
    audit: {
      append: (r: DispatchAuditRecord) => {
        audit.push(r);
        return Promise.resolve();
      },
    },
    metrics,
    log: createLogger('dispatch-test', { level: 'silent' }),
  };
  return {
    acts: createDispatchActivities(deps as never),
    rows,
    audit,
    insert,
    slots,
    metrics,
    deps,
  };
}

const rejected = (o: DispatchOutcome): string => (o.accepted ? 'accepted' : o.code);

describe('planDispatch', () => {
  it('accepts a valid dispatch with the tc/role egress identity and audits it', async () => {
    const { acts, rows, audit, metrics } = setup();
    const out = await acts.planDispatch(ref, request);
    expect(out.accepted && out.session?.egressIdentity).toBe(`tc_${TC}.role_admin`);
    expect(out.accepted && out.session?.persona).toBe('web-api-specialist');
    expect(rows.get(SUB)?.status).toBe('dispatched');
    expect(audit.map((a) => a.action)).toEqual(['subtask.dispatched']);
    expect(metrics.subtask).toHaveBeenCalledWith('web-api-specialist', 'dispatched');
  });

  it('is idempotent by subtaskId: no second row, slot or audit event, and no session once running', async () => {
    const { acts, insert, slots, audit } = setup();
    await acts.planDispatch(ref, request);
    const again = await acts.planDispatch(ref, request);
    expect(again.accepted && again.created).toBe(false);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(slots.acquire).toHaveBeenCalledTimes(1);
    expect(audit).toHaveLength(1);
    await acts.markSubtaskRunning({ ...ref, subtaskId: SUB });
    const third = await acts.planDispatch(ref, request);
    expect(third.accepted && third.session).toBeNull();
  });

  it('refuses to reuse a subtaskId for another persona', async () => {
    const { acts } = setup();
    await acts.planDispatch(ref, request);
    expect(
      rejected(await acts.planDispatch(ref, { ...request, persona: 'infrastructure-specialist' })),
    ).toBe('INVALID_REQUEST');
  });

  it('rejects a mismatched persona with PERSONA_INELIGIBLE, audit and metric, and holds no slot', async () => {
    const { acts, rows, audit, slots, metrics } = setup();
    const out = await acts.planDispatch(ref, { ...request, persona: 'infrastructure-specialist' });
    expect(rejected(out)).toBe('PERSONA_INELIGIBLE');
    expect(rows.size).toBe(0);
    expect(slots.acquire).not.toHaveBeenCalled();
    expect(audit.map((a) => a.action)).toEqual(['subtask.rejected']);
    expect(metrics.rejection).toHaveBeenCalledWith('PERSONA_INELIGIBLE');
  });

  it('rejects an unknown persona and a missing test case', async () => {
    expect(rejected(await setup().acts.planDispatch(ref, { ...request, persona: 'nobody' }))).toBe(
      'UNKNOWN_PERSONA',
    );
    expect(rejected(await setup({ testCase: null }).acts.planDispatch(ref, request))).toBe(
      'TEST_CASE_NOT_FOUND',
    );
  });

  it.each(['targets', 'oracle', 'negativeControl', 'budget', 'standardRefs', 'class'])(
    'rejects a brief missing %s with BRIEF_INCOMPLETE',
    async (field) => {
      const rest = Object.fromEntries(Object.entries(brief).filter(([key]) => key !== field));
      const { acts, rows } = setup();
      expect(rejected(await acts.planDispatch(ref, { ...request, brief: rest }))).toBe(
        'BRIEF_INCOMPLETE',
      );
      expect(rows.size).toBe(0);
    },
  );

  it('rejects malformed input without throwing', async () => {
    expect(rejected(await setup().acts.planDispatch(ref, null))).toBe('INVALID_REQUEST');
    expect(rejected(await setup().acts.planDispatch(ref, { ...request, persona: 5 }))).toBe(
      'INVALID_REQUEST',
    );
  });

  describe('state_changing guard (section 8.3)', () => {
    const sc = { class: 'state_changing' } as const;
    const scRequest = { ...request, brief: { ...brief, class: 'state_changing' } };

    it('denies without a reversal-journal pre-entry', async () => {
      const { acts, rows, slots } = setup({ testCase: sc, journal: false });
      expect(rejected(await acts.planDispatch(ref, scRequest))).toBe('REVERSAL_JOURNAL_MISSING');
      expect(rows.size).toBe(0);
      expect(slots.acquire).not.toHaveBeenCalled();
    });

    it('denies a test case that is not approved even with a journal entry', async () => {
      const { acts } = setup({ testCase: { ...sc, status: 'proposed' }, journal: true });
      expect(rejected(await acts.planDispatch(ref, scRequest))).toBe('TEST_CASE_NOT_APPROVED');
    });

    it('allows an approved case with a journal entry', async () => {
      const { acts } = setup({ testCase: sc, journal: true });
      expect(rejected(await acts.planDispatch(ref, scRequest))).toBe('accepted');
    });
  });

  describe('run state and capacity', () => {
    it.each([
      ['recon', 'RUN_NOT_EXECUTING'],
      ['paused', 'RUN_NOT_EXECUTING'],
      ['planning', 'RUN_NOT_EXECUTING'],
      ['killed', 'RUN_TERMINATING'],
      ['cancelled', 'RUN_TERMINATING'],
    ])('rejects dispatch while the run is %s', async (state, code) => {
      const { acts, rows, slots } = setup({ state });
      expect(rejected(await acts.planDispatch(ref, request))).toBe(code);
      expect(rows.size).toBe(0);
      expect(slots.acquire).not.toHaveBeenCalled();
    });

    it('rejects with CONCURRENCY_LIMIT or BUDGET_UNAVAILABLE and persists nothing', async () => {
      const limited = setup({ slot: 'limit' });
      expect(rejected(await limited.acts.planDispatch(ref, request))).toBe('CONCURRENCY_LIMIT');
      expect(limited.rows.size).toBe(0);
      expect(rejected(await setup({ slot: 'budget' }).acts.planDispatch(ref, request))).toBe(
        'BUDGET_UNAVAILABLE',
      );
    });

    it('does not start a second session when the insert loses a race', async () => {
      const { acts, rows, insert } = setup();
      const winner: SubtaskRow = {
        subtaskId: SUB,
        testCaseId: TC,
        persona: WEB_API.name,
        brief: brief as never,
        egressIdentity: 'x',
        status: 'running',
        sessionId: null,
        sandboxId: null,
        result: null,
        costUsd: 0,
      };
      insert.mockResolvedValue({ row: winner, created: false });
      const out = await acts.planDispatch(ref, request);
      expect(out.accepted && out.created).toBe(false);
      expect(out.accepted && out.session).toBeNull();
      expect(rows.size).toBe(0);
    });
  });
});

describe('lifecycle and results', () => {
  it('moves dispatched to running to a terminal status, stores the result and releases the slot', async () => {
    const { acts, slots, metrics } = setup();
    await acts.planDispatch(ref, request);
    await acts.markSubtaskRunning({ ...ref, subtaskId: SUB });
    expect(await acts.getSubtaskResult({ ...ref, subtaskId: SUB })).toMatchObject({
      found: true,
      status: 'running',
      result: null,
    });
    await acts.recordSubtaskResult({
      ...ref,
      subtaskId: SUB,
      sessionId: 's',
      sandboxId: 'sb',
      outcome: { status: 'submitted', declined: false },
      costUsd: 0.5,
    });
    expect(await acts.getSubtaskResult({ ...ref, subtaskId: SUB })).toMatchObject({
      found: true,
      status: 'submitted',
      result: { reason: null, declined: false },
    });
    expect(slots.release).toHaveBeenCalledWith(T, R, SUB);
    expect(metrics.subtask).toHaveBeenCalledWith('web-api-specialist', 'submitted');
  });

  it('records a refusal as model_declined and ignores a replayed result', async () => {
    const { acts, rows, metrics } = setup();
    await acts.planDispatch(ref, request);
    const declined = {
      ...ref,
      subtaskId: SUB,
      sessionId: null,
      sandboxId: null,
      outcome: { status: 'model_declined', reason: 'refusal', declined: true },
      costUsd: 0,
    } as const;
    await acts.recordSubtaskResult(declined);
    await acts.recordSubtaskResult({ ...declined, outcome: { status: 'failed', declined: false } });
    expect(rows.get(SUB)?.status).toBe('model_declined');
    expect(metrics.subtask).not.toHaveBeenCalledWith('web-api-specialist', 'failed');
  });

  it('reports found:false for an unknown subtask and audits the fetch', async () => {
    const { acts, audit } = setup();
    expect(await acts.getSubtaskResult({ ...ref, subtaskId: SUB })).toEqual({ found: false });
    expect(audit.at(-1)?.action).toBe('subtask.result_fetched');
  });
});

describe('egressIdentityFor', () => {
  it('formats tc_<testCaseId>.role_<roleId>', () => {
    expect(egressIdentityFor('abc', 'admin')).toBe('tc_abc.role_admin');
    expect(egressIdentityFor('abc', undefined)).toBe('tc_abc');
  });
});
