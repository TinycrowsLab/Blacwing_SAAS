import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { GENERATED_DIR, PACKAGE_ROOT, readSpec, renderGeneratedFiles } from './generate.js';

/** `pnpm --filter @blackwing/api-client api-client:gen`: regenerates the committed client files. */
async function main(): Promise<void> {
  const files = await renderGeneratedFiles(readSpec());
  const dir = path.join(PACKAGE_ROOT, GENERATED_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'schema.ts'), files.schema);
  writeFileSync(path.join(dir, 'operations.ts'), files.operations);
  process.stdout.write(`api-client: wrote ${GENERATED_DIR}/schema.ts and operations.ts\n`);
}

await main();
