import { PromptError } from './prompt.js';

/**
 * Placeholders the base preamble (REGISTRY-003) exposes. Composition (REGISTRY-004) fills them from the
 * signed run envelope; filling is strict so an unfilled authorisation context can never reach a model.
 */
export const PREAMBLE_PLACEHOLDERS = [
  'saId',
  'assetScope',
  'testWindow',
  'maxIntrusiveness',
  'roles',
  'approverIdentity',
] as const;
export type PreamblePlaceholder = (typeof PREAMBLE_PLACEHOLDERS)[number];

const TOKEN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * Fills the preamble's `{name}` placeholders in one pass (values are never re-scanned). Throws
 * `PROMPT_INVALID` if a value is missing or empty, or if the text names a placeholder that is not
 * part of the contract.
 */
export function fillPreamble(
  body: string,
  values: Readonly<Record<PreamblePlaceholder, string>>,
): string {
  const known = PREAMBLE_PLACEHOLDERS as readonly string[];
  for (const key of PREAMBLE_PLACEHOLDERS) {
    if (typeof values[key] !== 'string' || values[key].trim() === '') {
      throw new PromptError('PROMPT_INVALID', `PROMPT_INVALID: placeholder ${key} is unfilled`);
    }
  }
  return body.replace(TOKEN, (_m, key: string) => {
    if (!known.includes(key)) {
      throw new PromptError('PROMPT_INVALID', `PROMPT_INVALID: unknown placeholder ${key}`);
    }
    return values[key as PreamblePlaceholder];
  });
}
