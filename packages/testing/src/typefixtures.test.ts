// Proves that the strict options of tsconfig.base.json are in force (FOUND-003).
//
// Every fixture under ../typefixtures marks a violation with
//   // @ts-expect-error TS<code> <option>: <reason>
// This test compiles the fixtures three ways:
//   1. as written: no diagnostics at all (every directive is used, nothing else fails);
//   2. with the directives stripped: exactly the declared TS<code> on each marked line, so a
//      directive can never be satisfied by an unrelated error;
//   3. with the named option relaxed: the directive becomes unused (TS2578), i.e. relaxing the
//      option breaks `tsc -b` instead of passing silently.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../typefixtures");
const CONFIG_PATH = path.join(FIXTURES_DIR, "tsconfig.json");
const DIRECTIVE = /^\s*\/\/ @ts-expect-error TS(\d+) ([A-Za-z]+): \S.*$/;
const ANY_DIRECTIVE = /@ts-expect-error/;
const UNUSED_DIRECTIVE = 2578;
const COMPILE_TIMEOUT_MS = 120_000;

/**
 * Overrides that switch each covered option back to its permissive value. Options implied by
 * another one (isolatedModules by verbatimModuleSyntax, the strict family by `strict`) are
 * relaxed together with it, otherwise the implication would keep the check alive.
 */
const RELAXED: Readonly<Record<string, ts.CompilerOptions>> = {
  noImplicitAny: { noImplicitAny: false },
  strictNullChecks: { strictNullChecks: false },
  strictPropertyInitialization: { strictPropertyInitialization: false },
  useUnknownInCatchVariables: { useUnknownInCatchVariables: false },
  noImplicitThis: { noImplicitThis: false },
  strictFunctionTypes: { strictFunctionTypes: false },
  strictBindCallApply: { strictBindCallApply: false },
  noUncheckedIndexedAccess: { noUncheckedIndexedAccess: false },
  exactOptionalPropertyTypes: { exactOptionalPropertyTypes: false },
  noImplicitOverride: { noImplicitOverride: false },
  noImplicitReturns: { noImplicitReturns: false },
  noFallthroughCasesInSwitch: { noFallthroughCasesInSwitch: false },
  allowUnreachableCode: { allowUnreachableCode: true },
  allowUnusedLabels: { allowUnusedLabels: true },
  verbatimModuleSyntax: { verbatimModuleSyntax: false },
  isolatedModules: { verbatimModuleSyntax: false, isolatedModules: false },
  lib: { lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] },
};

interface Directive {
  readonly file: string;
  /** Zero-based line of the directive; the violation is on the next line. */
  readonly line: number;
  readonly code: number;
  readonly option: string;
}

function loadProject(): ts.ParsedCommandLine {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(CONFIG_PATH, undefined, host);
  if (parsed === undefined) throw new Error(`cannot parse ${CONFIG_PATH}`);
  if (parsed.errors.length > 0) throw new Error(format(parsed.errors));
  return parsed;
}

function format(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const where =
        diagnostic.file !== undefined && diagnostic.start !== undefined
          ? `${path.relative(FIXTURES_DIR, diagnostic.file.fileName)}:${String(
              diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
            )} `
          : "";
      return `${where}TS${String(diagnostic.code)} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    })
    .join("\n");
}

const project = loadProject();
const sources = new Map(project.fileNames.map((file) => [path.normalize(file), readFileSync(file, "utf8")]));

function collectDirectives(): Directive[] {
  const directives: Directive[] = [];
  for (const [file, text] of sources) {
    text.split("\n").forEach((content, line) => {
      const match = DIRECTIVE.exec(content);
      if (match === null) {
        if (ANY_DIRECTIVE.test(content)) {
          throw new Error(`${file}:${String(line + 1)}: @ts-expect-error must name "TS<code> <option>: <reason>"`);
        }
        return;
      }
      const [, code, option] = match;
      if (code === undefined || option === undefined) return;
      directives.push({ file, line, code: Number(code), option });
    });
  }
  return directives;
}

const directives = collectDirectives();

/** Shares parsed lib / @types files across the programs built by this suite. */
const sharedSourceFiles = new Map<string, ts.SourceFile>();

function compile(overrides: ts.CompilerOptions, rewrite?: (file: string, text: string) => string): ts.Diagnostic[] {
  const options: ts.CompilerOptions = {
    ...project.options,
    ...overrides,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const fixtureText = (fileName: string): string | undefined => {
    const text = sources.get(path.normalize(fileName));
    return text === undefined || rewrite === undefined ? text : rewrite(path.normalize(fileName), text);
  };
  host.readFile = (fileName) => fixtureText(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = fixtureText(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    const cacheKey = `${fileName}\0${JSON.stringify(languageVersion)}`;
    const cached = sharedSourceFiles.get(cacheKey);
    if (cached !== undefined) return cached;
    const created = getSourceFile(fileName, languageVersion, onError, shouldCreate);
    if (created !== undefined) sharedSourceFiles.set(cacheKey, created);
    return created;
  };
  const program = ts.createProgram({ rootNames: project.fileNames, options, host });
  return [...ts.getPreEmitDiagnostics(program)];
}

function lineOf(diagnostic: ts.Diagnostic): number | undefined {
  if (diagnostic.file === undefined || diagnostic.start === undefined) return undefined;
  return diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line;
}

function stripDirectives(_file: string, text: string): string {
  return text
    .split("\n")
    .map((content) => (DIRECTIVE.test(content) ? content.replace("@ts-expect-error", "(directive removed)") : content))
    .join("\n");
}

describe("strict typefixtures (packages/testing/typefixtures)", () => {
  it("covers every strict option relaxed by this suite", () => {
    const covered = new Set(directives.map((directive) => directive.option));
    expect([...covered].sort()).toEqual(Object.keys(RELAXED).sort());
  });

  it("compiles cleanly as written: every @ts-expect-error is used", { timeout: COMPILE_TIMEOUT_MS }, () => {
    const diagnostics = compile({});
    expect(format(diagnostics)).toBe("");
  });

  it("reports exactly the declared error on each marked line once the directive is removed", { timeout: COMPILE_TIMEOUT_MS }, () => {
    const diagnostics = compile({}, stripDirectives);
    const found = diagnostics.map((diagnostic) => ({
      file: diagnostic.file === undefined ? "" : path.normalize(diagnostic.file.fileName),
      line: lineOf(diagnostic),
      code: diagnostic.code,
    }));
    const expected = directives.map((directive) => ({ file: directive.file, line: directive.line + 1, code: directive.code }));
    const key = (entry: { file: string; line: number | undefined; code: number }): string =>
      `${path.relative(FIXTURES_DIR, entry.file)}:${String((entry.line ?? -1) + 1)} TS${String(entry.code)}`;
    expect(found.map(key).sort()).toEqual(expected.map(key).sort());
  });

  describe.each(Object.keys(RELAXED))("relaxing %s", (option) => {
    it("turns its fixture directives into unused-directive errors (TS2578)", { timeout: COMPILE_TIMEOUT_MS }, () => {
      const overrides = RELAXED[option];
      if (overrides === undefined) throw new Error(`no relaxation for ${option}`);
      const unused = new Set(
        compile(overrides)
          .filter((diagnostic) => diagnostic.code === UNUSED_DIRECTIVE)
          .map((diagnostic) => `${diagnostic.file?.fileName ?? ""}:${String(lineOf(diagnostic))}`),
      );
      const mine = directives.filter((directive) => directive.option === option);
      expect(mine.length).toBeGreaterThan(0);
      for (const directive of mine) {
        expect(unused, `${path.relative(FIXTURES_DIR, directive.file)}:${String(directive.line + 1)}`).toContain(
          `${directive.file}:${String(directive.line)}`,
        );
      }
    });
  });
});
