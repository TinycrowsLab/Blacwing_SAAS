import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERSONA_CATALOGUE_PATH, renderPersonaCatalogue } from './catalogue.js';
import { loadPersona, PERSONA_NAMES, type PersonaDefinition } from './persona.js';
import { orchestratorPersona, plannerPersona, subPlannerPersona } from './personas/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const roster = (): PersonaDefinition[] => PERSONA_NAMES.map((name) => loadPersona(name));

describe('persona catalogue (REGISTRY-011)', () => {
  it('lists all 19 personas in roster order, each with a section heading', () => {
    const page = renderPersonaCatalogue(roster());
    const headings = [...page.matchAll(/^## `([a-z-]+)`$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...PERSONA_NAMES]);
    expect(PERSONA_NAMES).toHaveLength(19);
  });

  it('is derived from the definitions: tier to model, effort, turns, budget, tools and oracles', () => {
    const page = renderPersonaCatalogue([plannerPersona]);
    expect(page).toContain('- **Model tier:** `deep` → `claude-opus-5-5`');
    expect(page).toContain('- **Effort:** `high`; **max turns:** 40; **default budget:** $5');
    expect(page).toContain(
      '- **Intrusiveness ceiling:** `state_changing`; **submission required:** no',
    );
    expect(page).toContain('- **Prompt version:** `1.0.0`');
    for (const tool of plannerPersona.allowedTools) expect(page).toContain(`\`${tool}\``);
    for (const tool of plannerPersona.disallowedTools) expect(page).toContain(`\`${tool}\``);
    for (const oracle of plannerPersona.declaredOracleTypes) {
      expect(page).toContain(`\`${oracle}\``);
    }
  });

  it('shows the standard tier as its own alias and the helpers of a persona that has them', () => {
    const page = renderPersonaCatalogue([subPlannerPersona, orchestratorPersona]);
    expect(page).toContain('- **Model tier:** `standard` → `claude-opus-5-5`');
    const withHelpers = renderPersonaCatalogue(roster());
    expect(withHelpers).toMatch(/\*\*Helpers:\*\* `[a-z-]+` \(tier `\w+`, tools /);
  });

  it('writes "none" for an empty list instead of an empty code span', () => {
    const page = renderPersonaCatalogue([{ ...plannerPersona, declaredOracleTypes: [] }]);
    expect(page).toContain('- **Declared oracle types:** _none_');
    expect(page).not.toContain('``');
  });

  it('is deterministic: the same definitions always render the same bytes', () => {
    expect(renderPersonaCatalogue(roster())).toBe(renderPersonaCatalogue(roster()));
  });

  it('matches the committed docs/architecture/persona-catalogue.md (CI drift check)', () => {
    const committed = readFileSync(`${REPO_ROOT}/${PERSONA_CATALOGUE_PATH}`, 'utf8');
    expect(committed).toBe(renderPersonaCatalogue(roster()));
  });
});
