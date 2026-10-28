// `pnpm gen:persona-catalogue` (REGISTRY-011): writes docs/architecture/persona-catalogue.md from the persona
// definitions. The drift check (scripts/check-drift.mjs stale) fails the build when the committed page is stale.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERSONA_CATALOGUE_PATH, renderPersonaCatalogue } from './catalogue.js';
import { loadPersona, PERSONA_NAMES } from './persona.js';
import './personas/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const definitions = PERSONA_NAMES.map((name) => loadPersona(name));
writeFileSync(join(REPO_ROOT, PERSONA_CATALOGUE_PATH), renderPersonaCatalogue(definitions));
process.stdout.write(
  `persona-catalogue: wrote ${PERSONA_CATALOGUE_PATH} (${String(definitions.length)} persona(s))\n`,
);
