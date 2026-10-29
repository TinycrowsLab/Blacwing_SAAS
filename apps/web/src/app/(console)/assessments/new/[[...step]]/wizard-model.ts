// Scoping wizard model (SCOPE-005 console form). Pure: no React, no I/O, so the step rules, the permission
// gate and the URL state are unit-tested directly. The server re-checks every rule (§8.6, §8.10); this model only
// decides what the console shows and what it asks the API for.

import { z } from 'zod';

import {
  ASSESSMENT_REQUEST_ASSETS_MAX,
  isRole,
  LIMITS,
  ROLE_PERMISSIONS,
  runModeSchema,
  type RunMode,
} from '@blackwing/contracts';

/** The wizard steps in order. The URL names one of them: `/assessments/new/<step>`. */
export const WIZARD_STEPS = ['mode', 'assets', 'objective'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === 'string' && (WIZARD_STEPS as readonly string[]).includes(value);
}

/** Answers the wizard has so far. `mode` is null until chosen; the objective is the last answer. */
export interface WizardState {
  readonly mode: RunMode | null;
  readonly assetIds: readonly string[];
  readonly objective: string;
}

/**
 * The first step whose answer is still missing. The objective is the last step, so it is the answer when the
 * earlier two are complete. A later step is never shown before this one (deep links are redirected here).
 */
export function firstIncompleteStep(state: Pick<WizardState, 'mode' | 'assetIds'>): WizardStep {
  if (state.mode === null) return 'mode';
  if (state.assetIds.length === 0) return 'assets';
  return 'objective';
}

/** True when `step` may be shown for this state: it is the first incomplete step or one before it. */
export function canShowStep(
  step: WizardStep,
  state: Pick<WizardState, 'mode' | 'assetIds'>,
): boolean {
  return WIZARD_STEPS.indexOf(step) <= WIZARD_STEPS.indexOf(firstIncompleteStep(state));
}

/** Cosmetic gate of the console (enforcement is server-side). The role must hold `assessment:create`. */
export function canCreateAssessment(roles: readonly string[]): boolean {
  return roles.some((role) => isRole(role) && ROLE_PERMISSIONS[role].includes('assessment:create'));
}

/** Only a verified asset is selectable (§8.10). Anything else is shown disabled, with a way to verify it. */
export function isSelectableAsset(verificationStatus: string): boolean {
  return verificationStatus === 'verified';
}

/** Run modes with the engineering altitude each one implies. Read-only text, never a control. */
export const MODE_OPTIONS: readonly {
  readonly value: RunMode;
  readonly label: string;
  readonly altitude: string;
  readonly reconImplication: string;
}[] = [
  {
    value: 'black',
    label: 'Black box',
    altitude: 'No prior knowledge. The agents start from the outside, the way an outsider would.',
    reconImplication: 'Broadest recon. Expect the most requests and the longest discovery phase.',
  },
  {
    value: 'grey',
    label: 'Grey box',
    altitude: 'Partial knowledge, such as a test account or a role matrix supplied to the agents.',
    reconImplication: 'Targeted recon guided by the supplied knowledge.',
  },
  {
    value: 'white',
    label: 'White box',
    altitude: 'Full knowledge, such as the source and the architecture shared with the agents.',
    reconImplication: 'Lightest recon. The supplied inputs direct the test cases.',
  },
];

/** Objective presets. A preset is a starting sentence the user edits, never an exploit or a payload. */
export const OBJECTIVE_PRESETS: readonly {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}[] = [
  {
    id: 'full_surface',
    label: 'Full surface',
    text: 'Map and assess the full externally reachable surface of the selected assets.',
  },
  {
    id: 'auth_access',
    label: 'Auth and access control',
    text: 'Assess authentication and access control, including authorisation between roles and tenants.',
  },
  {
    id: 'api_inventory',
    label: 'API inventory',
    text: 'Inventory the API endpoints of the selected assets and check their documented behaviour.',
  },
];

export const modeAnswerSchema = z.object({ mode: runModeSchema });

export const assetAnswerSchema = z.object({
  assetIds: z
    .array(z.uuid())
    .min(1, 'Select at least one verified asset.')
    .max(
      ASSESSMENT_REQUEST_ASSETS_MAX,
      `Select at most ${String(ASSESSMENT_REQUEST_ASSETS_MAX)} assets.`,
    ),
});

export const objectiveAnswerSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(1, 'Describe the objective of this assessment.')
    .max(
      LIMITS.objectiveMax,
      `Keep the objective to ${String(LIMITS.objectiveMax)} characters or fewer.`,
    ),
});

/** Adds or removes one asset id, keeping the selection unique and in the order it was chosen. */
export function toggleAsset(
  selected: readonly string[],
  assetId: string,
  checked: boolean,
): string[] {
  if (!checked) return selected.filter((id) => id !== assetId);
  return selected.includes(assetId) ? [...selected] : [...selected, assetId];
}

const UUID_LIST_LIMIT = ASSESSMENT_REQUEST_ASSETS_MAX;

/**
 * Reads the pre-draft answers from the URL (`?mode=grey&assets=<uuid>,<uuid>`). Anything that is not a valid mode or
 * UUID is dropped, so a tampered URL cannot smuggle an unknown value into a request.
 */
export function readWizardState(
  params: Readonly<Record<string, string | string[] | undefined>>,
): WizardState {
  const modeParam = first(params.mode);
  const mode = runModeSchema.safeParse(modeParam);
  const assetIds = (first(params.assets) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => z.uuid().safeParse(part).success)
    .slice(0, UUID_LIST_LIMIT);
  return {
    mode: mode.success ? mode.data : null,
    assetIds: [...new Set(assetIds)],
    objective: '',
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The step before or after `step`, or undefined at either end. */
export function neighbourStep(step: WizardStep, offset: -1 | 1): WizardStep | undefined {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + offset];
}

/**
 * Link to a step. Once a draft exists the URL names it (`?request=areq_…`), so a refresh or a bookmark resumes it.
 * Before that, the answers so far ride in the URL (`mode`, `assets`), so a refresh keeps them.
 */
export function wizardHref(
  step: WizardStep,
  answers: {
    readonly requestId: string | null;
    readonly mode: RunMode | null;
    readonly assetIds: readonly string[];
  },
): string {
  const params = new URLSearchParams();
  if (answers.requestId !== null) {
    params.set('request', answers.requestId);
  } else {
    if (answers.mode !== null) params.set('mode', answers.mode);
    if (answers.assetIds.length > 0) params.set('assets', answers.assetIds.join(','));
  }
  const query = params.toString();
  return `/assessments/new/${step}${query === '' ? '' : `?${query}`}`;
}
