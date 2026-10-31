// MENTOR-001 (#420): stall-rule thresholds load with defaults, honour overrides and fail closed on bad input.
import { describe, expect, it } from 'vitest';

import { loadConfig } from './env.js';
import { isConfigValidationError } from './errors.js';
import { stallConfigFromEnv, stallEnvSchema, stallThresholdsSchema } from './stall.js';

const load = (env: Record<string, string>) => loadConfig(stallEnvSchema, env);

describe('stall thresholds (MENTOR-001)', () => {
  it('defaults to the issue thresholds when no key is set', () => {
    const { thresholds, personaOverrides } = stallConfigFromEnv(load({}));
    expect(thresholds).toEqual({
      noProgressTurns: 6,
      toolLoopRepeats: 4,
      errorLoop: 3,
      budgetDeltaUsd: 0.5,
      subtaskMaxMinutes: 20,
    });
    expect(personaOverrides).toEqual({});
  });

  it('reads every threshold from its env key', () => {
    const { thresholds } = stallConfigFromEnv(
      load({
        STALL_NO_PROGRESS_TURNS: '12',
        STALL_TOOL_LOOP_REPEATS: '7',
        STALL_ERROR_LOOP: '5',
        STALL_BUDGET_DELTA_USD: '1.25',
        STALL_SUBTASK_MAX_MIN: '45',
      }),
    );
    expect(thresholds).toEqual({
      noProgressTurns: 12,
      toolLoopRepeats: 7,
      errorLoop: 5,
      budgetDeltaUsd: 1.25,
      subtaskMaxMinutes: 45,
    });
  });

  it.each([
    ['STALL_NO_PROGRESS_TURNS', '0'],
    ['STALL_NO_PROGRESS_TURNS', '-3'],
    ['STALL_NO_PROGRESS_TURNS', '06'],
    ['STALL_NO_PROGRESS_TURNS', '6.5'],
    ['STALL_NO_PROGRESS_TURNS', '1e3'],
    ['STALL_NO_PROGRESS_TURNS', '100001'],
    ['STALL_TOOL_LOOP_REPEATS', 'many'],
    ['STALL_BUDGET_DELTA_USD', '0'],
    ['STALL_BUDGET_DELTA_USD', '-0.5'],
    ['STALL_BUDGET_DELTA_USD', '1e2'],
    ['STALL_BUDGET_DELTA_USD', '10001'],
    ['STALL_SUBTASK_MAX_MIN', '1441'],
    ['STALL_PERSONA_OVERRIDES', '{not json'],
    ['STALL_PERSONA_OVERRIDES', '[]'],
    ['STALL_PERSONA_OVERRIDES', '{"Exploit Developer":{"errorLoop":3}}'],
    ['STALL_PERSONA_OVERRIDES', '{"mentor":{"errorLoop":1}}'],
    ['STALL_PERSONA_OVERRIDES', '{"mentor":{"unknownKey":3}}'],
  ])('rejects invalid %s=%j at load', (key, value) => {
    let caught: unknown;
    try {
      load({ [key]: value });
    } catch (error) {
      caught = error;
    }
    expect(isConfigValidationError(caught)).toBe(true);
  });

  it('applies per-persona overrides as partial thresholds, keyed by persona name', () => {
    const { personaOverrides } = stallConfigFromEnv(
      load({
        STALL_PERSONA_OVERRIDES: JSON.stringify({
          'deep-specialist': { noProgressTurns: 30, subtaskMaxMinutes: 60 },
          mentor: { errorLoop: 2 },
        }),
      }),
    );
    expect(personaOverrides).toEqual({
      'deep-specialist': { noProgressTurns: 30, subtaskMaxMinutes: 60 },
      mentor: { errorLoop: 2 },
    });
  });

  it('strict thresholds reject unknown and out-of-range fields', () => {
    expect(
      stallThresholdsSchema.safeParse({
        noProgressTurns: 6,
        toolLoopRepeats: 4,
        errorLoop: 3,
        budgetDeltaUsd: 0.5,
        subtaskMaxMinutes: 20,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      stallThresholdsSchema.safeParse({
        noProgressTurns: 0,
        toolLoopRepeats: 4,
        errorLoop: 3,
        budgetDeltaUsd: 0.5,
        subtaskMaxMinutes: 20,
      }).success,
    ).toBe(false);
  });
});
