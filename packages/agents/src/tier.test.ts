import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_ALLOWLIST,
  MODEL_PROVIDERS,
  type ModelProvider,
  TierError,
  defaultEffort,
  pinRunModels,
  resolveTier,
} from './tier.js';

const BASE = {
  deep: 'claude-opus-5-5',
  standard: 'claude-opus-5-5',
  fast: 'claude-haiku-5-5',
} as const;

describe('resolveTier', () => {
  it.each(
    MODEL_PROVIDERS.flatMap((p) =>
      (['deep', 'standard', 'fast'] as const).map((t) => [p, t] as const),
    ),
  )('%s/%s resolves with the right prefix', (provider, tier) => {
    const expected = provider === 'bedrock' ? `anthropic.${BASE[tier]}` : BASE[tier];
    expect(resolveTier(tier, provider)).toBe(expected);
  });

  it('lowerStandard moves only standard to sonnet', () => {
    expect(resolveTier('standard', 'anthropic', { lowerStandard: true })).toBe('claude-sonnet-5-5');
    expect(resolveTier('standard', 'bedrock', { lowerStandard: true })).toBe(
      'anthropic.claude-sonnet-5-5',
    );
    expect(resolveTier('deep', 'anthropic', { lowerStandard: true })).toBe('claude-opus-5-5');
    expect(resolveTier('fast', 'anthropic', { lowerStandard: true })).toBe('claude-haiku-5-5');
  });

  it('absent or false flag means no lowering', () => {
    expect(resolveTier('standard', 'vertex')).toBe('claude-opus-5-5');
    expect(resolveTier('standard', 'vertex', { lowerStandard: false })).toBe('claude-opus-5-5');
  });

  it('rejects a non-allowlisted model, never substituting', () => {
    expect(() => resolveTier('fast', 'anthropic', {}, ['claude-opus-5-5'])).toThrowError(
      /MODEL_NOT_ALLOWED/,
    );
    expect(() =>
      resolveTier('standard', 'foundry', { lowerStandard: true }, ['claude-opus-5-5']),
    ).toThrowError(TierError);
  });

  it('rejects unknown provider and alias', () => {
    expect(() => resolveTier('deep', 'openai' as ModelProvider)).toThrowError(/MODEL_NOT_ALLOWED/);
    expect(() => resolveTier('ultra' as 'deep', 'anthropic')).toThrowError(/MODEL_NOT_ALLOWED/);
  });

  it('carries the registered error code', () => {
    expect(new TierError('x').code).toBe('MODEL_NOT_ALLOWED');
    expect(() => resolveTier('deep', 'x' as ModelProvider)).toThrowError(TierError);
  });

  it('default allowlist has no date-suffixed ids', () => {
    expect(DEFAULT_MODEL_ALLOWLIST.every((m) => !/-\d{8}$/.test(m))).toBe(true);
  });
});

describe('pinRunModels', () => {
  const personas = [
    { name: 'planner', tierAlias: 'deep' },
    { name: 'reporter', tierAlias: 'standard' },
    { name: 'osint', tierAlias: 'fast', effort: 'low' },
  ] as const;

  it('returns model and effort per persona with defaults and overrides', () => {
    expect(pinRunModels(personas, 'bedrock', { lowerStandard: true })).toEqual({
      planner: { model: 'anthropic.claude-opus-5-5', effort: 'high' },
      reporter: { model: 'anthropic.claude-sonnet-5-5', effort: 'medium' },
      osint: { model: 'anthropic.claude-haiku-5-5', effort: 'low' },
    });
  });

  it('is deeply frozen', () => {
    const pins = pinRunModels(personas, 'anthropic');
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins.planner)).toBe(true);
    expect(() => {
      (pins as Record<string, unknown>).planner = {};
    }).toThrow();
  });

  it('fails the whole set when one model is not allowed', () => {
    expect(() => pinRunModels(personas, 'anthropic', {}, ['claude-opus-5-5'])).toThrowError(
      /MODEL_NOT_ALLOWED/,
    );
  });

  it('effort defaults', () => {
    expect(defaultEffort('deep')).toBe('high');
    expect(defaultEffort('standard')).toBe('medium');
    expect(defaultEffort('fast')).toBe('medium');
  });
});
