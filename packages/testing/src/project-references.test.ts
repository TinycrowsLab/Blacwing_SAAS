// Proves the project-reference wiring rules of FOUND-003 with throwaway projects that extend
// the real tsconfig.base.json:
//   - circular references are rejected by `tsc -b` (TS6202);
//   - importing another package's sources without a `references` entry fails the build, so a
//     package cannot silently depend on a workspace package it has not declared;
//   - the same import builds once the reference is declared (dependency builds first).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BASE_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tsconfig.base.json");
const BUILD_TIMEOUT_MS = 120_000;

/** Diagnostic codes asserted below (see TypeScript's diagnosticMessages.json). */
const CIRCULAR_REFERENCES = 6202;
const FILE_NOT_IN_PROJECT = 6307;

interface BuildResult {
  readonly status: ts.ExitStatus;
  readonly codes: readonly number[];
  readonly messages: readonly string[];
}

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "bw-tsrefs-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeProject(name: string, source: string, references: readonly string[]): string {
  const dir = path.join(workdir, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: `@fixture/${name}`, type: "module" })}\n`);
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: BASE_CONFIG,
        // The throwaway projects have no node_modules; the real packages keep types: ["node"].
        compilerOptions: { rootDir: "src", outDir: "dist", tsBuildInfoFile: "dist/.tsbuildinfo", types: [] },
        include: ["src"],
        references: references.map((reference) => ({ path: `../${reference}` })),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(dir, "src", "index.ts"), source);
  return dir;
}

function build(project: string): BuildResult {
  const codes: number[] = [];
  const messages: string[] = [];
  const report = (diagnostic: ts.Diagnostic): void => {
    codes.push(diagnostic.code);
    messages.push(`TS${String(diagnostic.code)} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  };
  const host = ts.createSolutionBuilderHost(ts.sys, undefined, report, () => undefined);
  const status = ts.createSolutionBuilder(host, [project], {}).build();
  return { status, codes, messages };
}

describe("project references (tsc -b)", () => {
  it("rejects circular project references", { timeout: BUILD_TIMEOUT_MS }, () => {
    writeProject("alpha", 'export const alpha = "alpha";\n', ["beta"]);
    writeProject("beta", 'export const beta = "beta";\n', ["alpha"]);

    const result = build(path.join(workdir, "alpha"));

    expect(result.status).not.toBe(ts.ExitStatus.Success);
    expect(result.codes, result.messages.join("\n")).toContain(CIRCULAR_REFERENCES);
  });

  it("rejects importing a workspace package that is not referenced", { timeout: BUILD_TIMEOUT_MS }, () => {
    writeProject("contracts", 'export const schemaVersion = 1;\n', []);
    const api = writeProject(
      "api",
      'import { schemaVersion } from "../../contracts/src/index.js";\n\nexport const apiVersion: number = schemaVersion;\n',
      [],
    );

    const result = build(api);

    expect(result.status).not.toBe(ts.ExitStatus.Success);
    expect(result.codes, result.messages.join("\n")).toContain(FILE_NOT_IN_PROJECT);
  });

  it("builds the dependency first once the reference is declared", { timeout: BUILD_TIMEOUT_MS }, () => {
    writeProject("contracts", 'export const schemaVersion = 1;\n', []);
    const api = writeProject(
      "api",
      'import { schemaVersion } from "../../contracts/src/index.js";\n\nexport const apiVersion: number = schemaVersion;\n',
      ["contracts"],
    );

    const result = build(api);

    expect(result.messages).toEqual([]);
    expect(result.status).toBe(ts.ExitStatus.Success);
    expect(ts.sys.fileExists(path.join(workdir, "contracts", "dist", "index.d.ts"))).toBe(true);
    expect(ts.sys.fileExists(path.join(workdir, "contracts", "dist", ".tsbuildinfo"))).toBe(true);
    expect(ts.sys.fileExists(path.join(workdir, "api", "dist", "index.js"))).toBe(true);
  });
});
