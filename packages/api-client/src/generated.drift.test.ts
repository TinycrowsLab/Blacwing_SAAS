import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GENERATED_DIR,
  PACKAGE_ROOT,
  readSpec,
  renderGeneratedFiles,
} from './generator/generate.js';

/**
 * Fails when docs/api/openapi.json changed without regenerating the client (acceptance: the
 * `api-client:gen` drift check). Regenerate with `pnpm --filter @blackwing/api-client api-client:gen`.
 */
/** Rendering the whole client takes seconds on a loaded machine, past vitest's 5 s default. */
const RENDER_TIMEOUT_MS = 30_000;

describe('generated client is up to date with docs/api/openapi.json', () => {
  it(
    'matches the committed generated files byte for byte',
    async () => {
      const files = await renderGeneratedFiles(readSpec());
      const dir = path.join(PACKAGE_ROOT, GENERATED_DIR);
      expect(readFileSync(path.join(dir, 'schema.ts'), 'utf8')).toBe(files.schema);
      expect(readFileSync(path.join(dir, 'operations.ts'), 'utf8')).toBe(files.operations);
    },
    RENDER_TIMEOUT_MS,
  );
});
