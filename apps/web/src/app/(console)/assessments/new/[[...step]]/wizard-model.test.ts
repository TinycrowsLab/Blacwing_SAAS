import { describe, expect, it } from 'vitest';

import { LIMITS } from '@blackwing/contracts';

import {
  assetAnswerSchema,
  canCreateAssessment,
  canShowStep,
  firstIncompleteStep,
  isSelectableAsset,
  isWizardStep,
  MODE_OPTIONS,
  modeAnswerSchema,
  neighbourStep,
  objectiveAnswerSchema,
  OBJECTIVE_PRESETS,
  readWizardState,
  toggleAsset,
  wizardHref,
} from './wizard-model';

const A = '0198f0a0-0000-7000-8000-0000000000e1';
const B = '0198f0a0-0000-7000-8000-0000000000e2';

describe('wizard steps', () => {
  it('accepts only the four named steps', () => {
    expect(isWizardStep('mode')).toBe(true);
    expect(isWizardStep('assets')).toBe(true);
    expect(isWizardStep('objective')).toBe(true);
    expect(isWizardStep('scope')).toBe(true);
    expect(isWizardStep('submit')).toBe(false);
    expect(isWizardStep('../mode')).toBe(false);
    expect(isWizardStep(undefined)).toBe(false);
  });

  const none = { mode: null, assetIds: [], objective: '', saId: null };

  it('points at the first incomplete step: mode, assets, objective, then the scope', () => {
    expect(firstIncompleteStep(none)).toBe('mode');
    expect(firstIncompleteStep({ ...none, mode: 'grey' })).toBe('assets');
    expect(firstIncompleteStep({ ...none, mode: 'grey', assetIds: [A] })).toBe('objective');
    expect(firstIncompleteStep({ ...none, mode: 'grey', assetIds: [A], objective: '  ' })).toBe(
      'objective',
    );
    expect(
      firstIncompleteStep({ mode: 'grey', assetIds: [A], objective: 'Test', saId: null }),
    ).toBe('scope');
  });

  it('refuses a deep link to a later step of an incomplete draft and allows the first incomplete step', () => {
    expect(canShowStep('objective', none)).toBe(false);
    expect(canShowStep('assets', none)).toBe(false);
    expect(canShowStep('mode', none)).toBe(true);

    const noAssets = { ...none, mode: 'black' as const };
    expect(canShowStep('assets', noAssets)).toBe(true);
    expect(canShowStep('objective', noAssets)).toBe(false);

    const noObjective = { ...none, mode: 'black' as const, assetIds: [A] };
    expect(canShowStep('objective', noObjective)).toBe(true);
    expect(canShowStep('scope', noObjective)).toBe(false);

    const complete = { ...noObjective, objective: 'Test' };
    expect(canShowStep('mode', complete)).toBe(true);
    expect(canShowStep('objective', complete)).toBe(true);
    expect(canShowStep('scope', complete)).toBe(true);
  });

  it('moves to the neighbouring step and stops at both ends', () => {
    expect(neighbourStep('assets', 1)).toBe('objective');
    expect(neighbourStep('assets', -1)).toBe('mode');
    expect(neighbourStep('mode', -1)).toBeUndefined();
    expect(neighbourStep('objective', 1)).toBe('scope');
    expect(neighbourStep('scope', 1)).toBeUndefined();
  });
});

describe('permission gate (cosmetic, enforced by the API)', () => {
  it('shows the wizard to a role that holds assessment:create', () => {
    expect(canCreateAssessment(['org_admin'])).toBe(true);
    expect(canCreateAssessment(['appsec_engineer'])).toBe(true);
  });

  it('denies a role without assessment:create, an unknown role, and no role at all', () => {
    expect(canCreateAssessment(['asset_owner'])).toBe(false);
    expect(canCreateAssessment(['not_a_role'])).toBe(false);
    expect(canCreateAssessment([])).toBe(false);
  });
});

describe('asset selection', () => {
  it('selects only verified assets', () => {
    expect(isSelectableAsset('verified')).toBe(true);
    expect(isSelectableAsset('unverified')).toBe(false);
    expect(isSelectableAsset('pending')).toBe(false);
    expect(isSelectableAsset('rejected')).toBe(false);
  });

  it('keeps the selection unique and in the order it was chosen', () => {
    expect(toggleAsset([], A, true)).toEqual([A]);
    expect(toggleAsset([A], A, true)).toEqual([A]);
    expect(toggleAsset([A, B], A, false)).toEqual([B]);
    expect(toggleAsset([A], B, true)).toEqual([A, B]);
  });

  it('requires at least one asset and at most the contract cap', () => {
    expect(assetAnswerSchema.safeParse({ assetIds: [] }).success).toBe(false);
    expect(assetAnswerSchema.safeParse({ assetIds: [A] }).success).toBe(true);
    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `0198f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(assetAnswerSchema.safeParse({ assetIds: tooMany }).success).toBe(false);
    expect(assetAnswerSchema.safeParse({ assetIds: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('mode and objective answers', () => {
  it('accepts the three run modes and rejects anything else', () => {
    expect(MODE_OPTIONS.map((option) => option.value)).toEqual(['black', 'grey', 'white']);
    expect(modeAnswerSchema.safeParse({ mode: 'grey' }).success).toBe(true);
    expect(modeAnswerSchema.safeParse({ mode: 'destructive' }).success).toBe(false);
    expect(modeAnswerSchema.safeParse({}).success).toBe(false);
  });

  it('requires a non-blank objective and stops at the contract maximum', () => {
    expect(objectiveAnswerSchema.safeParse({ objective: '   ' }).success).toBe(false);
    expect(objectiveAnswerSchema.safeParse({ objective: 'Test the login flow' }).success).toBe(
      true,
    );
    expect(
      objectiveAnswerSchema.safeParse({ objective: 'x'.repeat(LIMITS.objectiveMax) }).success,
    ).toBe(true);
    expect(
      objectiveAnswerSchema.safeParse({ objective: 'x'.repeat(LIMITS.objectiveMax + 1) }).success,
    ).toBe(false);
  });

  it('keeps every preset within the objective limit and free of exploit wording', () => {
    for (const preset of OBJECTIVE_PRESETS) {
      expect(objectiveAnswerSchema.safeParse({ objective: preset.text }).success).toBe(true);
      expect(preset.text).not.toMatch(/payload|exploit|sql injection|bypass/i);
    }
  });
});

describe('URL state', () => {
  it('reads a valid mode and the valid asset ids, dropping anything else', () => {
    const state = readWizardState({
      mode: 'white',
      assets: `${A},not-a-uuid,${A},${B}`,
    });
    expect(state).toEqual({ mode: 'white', assetIds: [A, B], objective: '', saId: null });
  });

  it('ignores an unknown mode, and a repeated parameter takes the first value', () => {
    expect(readWizardState({ mode: 'destructive' })).toEqual({
      mode: null,
      assetIds: [],
      objective: '',
      saId: null,
    });
    expect(readWizardState({ mode: ['grey', 'black'] }).mode).toBe('grey');
  });

  it('builds a step link that names the draft once one exists, and the answers before it', () => {
    expect(wizardHref('assets', { requestId: null, mode: 'grey', assetIds: [A] })).toBe(
      `/assessments/new/assets?mode=grey&assets=${A}`,
    );
    expect(wizardHref('objective', { requestId: 'areq_01abc', mode: 'grey', assetIds: [A] })).toBe(
      '/assessments/new/objective?request=areq_01abc',
    );
    expect(wizardHref('mode', { requestId: null, mode: null, assetIds: [] })).toBe(
      '/assessments/new/mode',
    );
  });
});
