import { describe, expect, it } from 'vitest';

import {
  gate1DecisionSignalSchema,
  gate3ReleasedSignalSchema,
  increaseBudgetSignalSchema,
  killSignalSchema,
  pauseSignalSchema,
  raiseRunBudget,
  RUN_INPUT_MAX_ASSETS,
  RUN_QUERIES,
  RUN_RELEASE_MAX_FINDINGS,
  RUN_SIGNALS,
  runInputSchema,
  runWorkflowId,
  systemSignalSchema,
} from './run-workflow.js';

const ID = '0190a000-0000-7000-8000-000000000001';
const user = { kind: 'user', id: 'u1' } as const;
const input = {
  tenantId: ID,
  runId: ID,
  saId: ID,
  requestedBy: ID,
  mode: 'black',
  assetIds: [ID],
  objective: 'o',
  runManifest: { prompt: 'sha256:1' },
  budgets: { costCapUsd: 10, maxRequests: 100, maxDurationMs: 60_000 },
} as const;

describe('runInputSchema', () => {
  it('accepts a valid input', () => {
    expect(runInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    ['unknown field', { ...input, extra: 1 }],
    ['bad mode', { ...input, mode: 'red' }],
    ['no assets', { ...input, assetIds: [] }],
    [
      'too many assets',
      { ...input, assetIds: Array.from({ length: RUN_INPUT_MAX_ASSETS + 1 }, () => ID) },
    ],
    ['oversized objective', { ...input, objective: 'x'.repeat(4001) }],
    ['bad tenant id', { ...input, tenantId: 'nope' }],
    ['budget over ceiling', { ...input, budgets: { ...input.budgets, costCapUsd: 1e12 } }],
    [
      'huge manifest',
      {
        ...input,
        runManifest: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`k${String(i)}`, 'v']),
        ),
      },
    ],
  ])('rejects %s', (_name, bad) => {
    expect(runInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('signal payloads', () => {
  it('requires an actor on every signal', () => {
    expect(pauseSignalSchema.safeParse({ reason: 'operator_pause' }).success).toBe(false);
    expect(pauseSignalSchema.safeParse({ actor: user, reason: 'operator_pause' }).success).toBe(
      true,
    );
    expect(pauseSignalSchema.safeParse({ actor: user, reason: 'bored' }).success).toBe(false);
    expect(systemSignalSchema.safeParse({ actor: { kind: 'system', id: 'timer' } }).success).toBe(
      true,
    );
    expect(systemSignalSchema.safeParse({ actor: { kind: 'robot', id: 'x' } }).success).toBe(false);
  });

  it('validates decisions, findings and kill scope', () => {
    expect(gate1DecisionSignalSchema.safeParse({ actor: user, decision: 'approved' }).success).toBe(
      true,
    );
    expect(gate1DecisionSignalSchema.safeParse({ actor: user, decision: 'maybe' }).success).toBe(
      false,
    );
    expect(gate3ReleasedSignalSchema.safeParse({ actor: user, findingIds: [] }).success).toBe(
      false,
    );
    expect(
      gate3ReleasedSignalSchema.safeParse({
        actor: user,
        findingIds: Array.from({ length: RUN_RELEASE_MAX_FINDINGS + 1 }, () => ID),
      }).success,
    ).toBe(false);
    expect(killSignalSchema.safeParse({ actor: user, scope: 'tenant' }).success).toBe(true);
    expect(killSignalSchema.safeParse({ actor: user, scope: 'planet' }).success).toBe(false);
  });

  it('requires a positive, non-empty budget delta', () => {
    expect(increaseBudgetSignalSchema.safeParse({ actor: user, delta: {} }).success).toBe(false);
    expect(
      increaseBudgetSignalSchema.safeParse({ actor: user, delta: { costCapUsd: -1 } }).success,
    ).toBe(false);
    expect(
      increaseBudgetSignalSchema.safeParse({ actor: user, delta: { costCapUsd: 5 } }).success,
    ).toBe(true);
  });
});

describe('names and helpers', () => {
  it('has one name per signal and query', () => {
    expect(Object.keys(RUN_SIGNALS)).toHaveLength(9);
    expect(Object.keys(RUN_QUERIES)).toHaveLength(5);
    expect(new Set(Object.values(RUN_SIGNALS)).size).toBe(9);
  });

  it('derives the workflow id from the run id', () => {
    expect(runWorkflowId(ID)).toBe(`run_${ID}`);
  });

  it('raises a budget within the ceilings and refuses one beyond them', () => {
    expect(raiseRunBudget(input.budgets, { costCapUsd: 5 })).toEqual({
      ...input.budgets,
      costCapUsd: 15,
    });
    expect(raiseRunBudget(input.budgets, { costCapUsd: 1e12 })).toBeNull();
  });
});
