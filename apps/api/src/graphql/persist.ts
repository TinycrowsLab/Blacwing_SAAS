import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import { canonicalQueryText } from '@blackwing/contracts';

import {
  persistedHash,
  PERSISTED_PREVIOUS_GENERATIONS,
  type PersistedManifest,
} from './persisted.js';

/** A client source file: its path (for messages) and text. */
export interface SourceFile {
  readonly fileName: string;
  readonly text: string;
}

/** The client operations are defined by `defineQuery(...)` in the console and the CLI (never in the API). */
const DEFINE_QUERY = 'defineQuery';

function isStringLike(
  node: ts.Expression,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * The query text of every `defineQuery(...)` call in the sources. The argument must be a string literal or the
 * name of a top-level `const` string in the same file, so a document the script cannot read fails the build
 * rather than slipping past the manifest. Pure: the caller supplies the files.
 */
export function extractOperationTexts(files: readonly SourceFile[]): string[] {
  const texts: string[] = [];
  for (const { fileName, text } of files) {
    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const constants = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isStringLike(declaration.initializer)
        ) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === DEFINE_QUERY
      ) {
        const [argument] = node.arguments;
        const value =
          argument && isStringLike(argument)
            ? argument.text
            : argument && ts.isIdentifier(argument)
              ? constants.get(argument.text)
              : undefined;
        if (value === undefined) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          throw new Error(
            `${fileName}:${String(line)}: defineQuery needs a string literal or a top-level const string`,
          );
        }
        texts.push(value);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return texts;
}

/** The manifest of the operation texts: hash to canonical text, sorted by hash so the file is stable. */
export function buildManifest(texts: readonly string[]): PersistedManifest {
  const entries = new Map<string, string>();
  for (const text of texts) {
    entries.set(persistedHash(text), canonicalQueryText(text));
  }
  return new Map(
    [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** The JSON file form of a manifest: sorted keys, two-space indent, trailing newline (prettier's JSON style). */
export function serializeManifest(manifest: PersistedManifest): string {
  return `${JSON.stringify(Object.fromEntries(manifest), null, 2)}\n`;
}

/** The earlier generations file: a JSON array of manifests, newest first, at most `PERSISTED_PREVIOUS_GENERATIONS`. */
export function serializeGenerations(generations: readonly PersistedManifest[]): string {
  const objects = generations
    .slice(0, PERSISTED_PREVIOUS_GENERATIONS)
    .map((generation) => Object.fromEntries(generation));
  return `${JSON.stringify(objects, null, 2)}\n`;
}

/**
 * The generations to keep after a rewrite: the outgoing current manifest joins the front of the earlier ones
 * (dropping the oldest beyond the window). An empty outgoing manifest is not a generation worth keeping.
 */
export function rotateGenerations(
  outgoing: PersistedManifest,
  earlier: readonly PersistedManifest[],
): PersistedManifest[] {
  const kept = outgoing.size === 0 ? [...earlier] : [outgoing, ...earlier];
  return kept.slice(0, PERSISTED_PREVIOUS_GENERATIONS);
}

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT_ROOTS = [join(API_ROOT, '..', 'web', 'src'), join(API_ROOT, '..', 'cli', 'src')];
const CURRENT_FILE = join(API_ROOT, 'graphql', 'persisted.json');
const PREVIOUS_FILE = join(API_ROOT, 'graphql', 'persisted.previous.json');

function isSourceFile(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

function sourcesUnder(dir: string): SourceFile[] {
  if (!existsSync(dir)) return [];
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourcesUnder(path));
    else if (entry.isFile() && isSourceFile(entry.name))
      files.push({ fileName: path, text: readFileSync(path, 'utf8') });
  }
  return files;
}

function readOr(file: string, fallback: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback;
}

/**
 * `pnpm graphql:persist` rewrites the manifests from the console and CLI operations; `--check` fails when the
 * committed current manifest differs from them (the CI drift gate). A rewrite keeps the outgoing generation for
 * the rollout grace window.
 */
export function runPersist(argv: readonly string[]): number {
  const manifest = buildManifest(
    extractOperationTexts(CLIENT_ROOTS.flatMap((root) => sourcesUnder(root))),
  );
  const committed = readOr(CURRENT_FILE, '{}\n');
  if (argv.includes('--check')) {
    if (committed === serializeManifest(manifest)) return 0;
    process.stderr.write(`graphql:persist: ${CURRENT_FILE} is stale; run pnpm graphql:persist\n`);
    return 1;
  }
  const outgoing = parseCommitted(committed);
  const earlier = parseGenerations(readOr(PREVIOUS_FILE, '[]\n'));
  writeFileSync(PREVIOUS_FILE, serializeGenerations(rotateGenerations(outgoing, earlier)));
  writeFileSync(CURRENT_FILE, serializeManifest(manifest));
  process.stdout.write(`graphql:persist: ${String(manifest.size)} operation(s) written\n`);
  return 0;
}

function parseCommitted(text: string): PersistedManifest {
  return new Map(Object.entries(JSON.parse(text) as Record<string, string>));
}

function parseGenerations(text: string): PersistedManifest[] {
  return (JSON.parse(text) as Record<string, string>[]).map(
    (generation) => new Map(Object.entries(generation)),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPersist(process.argv.slice(2));
}
