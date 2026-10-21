import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createLogger, type Logger } from '@blackwing/logger';

import { buildOpenApiDocument, countOperations, countSchemas } from './document.js';
import { lintOpenApiDocument } from './lint.js';

import type { JsonObject } from './schema.js';

/** The committed spec; the typed client (API-012) and the drift check read it. */
export const SPEC_FILE = new URL('../../../../docs/api/openapi.json', import.meta.url);
const PACKAGE_FILE = new URL('../../package.json', import.meta.url);

/** The API package version, the spec's `info.version`. */
export function apiPackageVersion(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('apps/api/package.json has no version');
  return parsed.version;
}

/** The public document for the current code. */
export function currentOpenApiDocument(): JsonObject {
  return buildOpenApiDocument({ version: apiPackageVersion() });
}

export const serialiseSpec = (document: JsonObject): string =>
  `${JSON.stringify(document, null, 2)}\n`;

export interface EmitResult {
  readonly operations: number;
  readonly schemas: number;
  /** `check` mode only: the committed file is missing or differs from the generated document. */
  readonly stale: boolean;
}

/**
 * Generates the spec, refuses one that fails the project lint, then writes it (`emit`) or compares it
 * with the committed file as data (`check`, the CI drift check).
 */
export function emitOpenApi(options: {
  readonly mode: 'emit' | 'check';
  readonly logger?: Logger;
  readonly file?: URL;
}): EmitResult {
  const file = options.file ?? SPEC_FILE;
  const document = currentOpenApiDocument();
  const problems = lintOpenApiDocument(document);
  if (problems.length > 0) {
    throw new Error(`generated OpenAPI document is invalid:\n${problems.join('\n')}`);
  }
  const operations = countOperations(document);
  const schemas = countSchemas(document);
  let stale = false;
  if (options.mode === 'emit') {
    mkdirSync(new URL('.', file), { recursive: true });
    writeFileSync(file, serialiseSpec(document));
  } else {
    // Compared as data: the committed file may be Prettier-formatted.
    stale =
      !existsSync(file) ||
      JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) !== JSON.stringify(document);
  }
  options.logger?.info({ operations, schemas, mode: options.mode, stale }, 'openapi.emitted');
  return { operations, schemas, stale };
}

/** CLI: `tsx src/openapi/emit.ts [--check]`. */
function main(argv: readonly string[]): number {
  const logger = createLogger('api-openapi');
  const mode = argv.includes('--check') ? 'check' : 'emit';
  const result = emitOpenApi({ mode, logger });
  if (result.stale) {
    process.stderr.write(
      'docs/api/openapi.json is out of date. Run `pnpm --filter @blackwing/api openapi:emit` and commit it.\n',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
