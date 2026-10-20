// Smoke test: a real app bootstrap in a child process exits non-zero on bad env (fail closed) and
// reports key names only.
//
// The child runs plain JavaScript: `beforeAll` transpiles this package's sources once (no type
// checking; `pnpm typecheck` does that) into a scratch directory under the package's node_modules, so
// `zod` resolves exactly as it does for the package and each child starts without loading a compiler.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONFIG_EXIT_CODE } from "./env.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(srcDir, "..", "node_modules", ".cache");
/** Generous: the full workspace suite runs many packages in parallel on a shared machine. */
const CHILD_TIMEOUT_MS = 30_000;

let buildDir = "";

/** Product sources plus the bootstrap fixture; tests are not needed by the child. */
function sourcesToBuild(): string[] {
  const product = readdirSync(srcDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  return [...product.map((file) => join(srcDir, file)), join(srcDir, "testdata", "bootstrap-app.ts")];
}

function transpileSources(outDir: string): void {
  for (const fileName of sourcesToBuild()) {
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
        sourceMap: false,
      },
    });
    const target = join(outDir, relative(srcDir, fileName)).replace(/\.ts$/, ".js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
  // Mark the scratch tree as ESM, like the package itself.
  writeFileSync(join(outDir, "package.json"), '{ "type": "module" }\n');
}

beforeAll(() => {
  mkdirSync(cacheDir, { recursive: true });
  buildDir = mkdtempSync(join(cacheDir, "config-bootstrap-"));
  transpileSources(buildDir);
}, 60_000);

afterAll(() => {
  if (buildDir !== "") {
    rmSync(buildDir, { recursive: true, force: true });
  }
});

function runApp(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(buildDir, "testdata", "bootstrap-app.js")], {
    // Only what the child needs: never inherit the parent's environment wholesale.
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("app bootstrap (child process)", { timeout: CHILD_TIMEOUT_MS + 5_000 }, () => {
  it("starts with a valid environment", () => {
    const { status, stdout, stderr } = runApp({
      NODE_ENV: "production",
      PORT: "13400",
      API_TOKEN: "tok-child-ok-0009",
      DATABASE_URL: "postgres://bw:pw-child-ok-0009@localhost:15432/bw",
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      started: true,
      keys: ["API_TOKEN", "DATABASE_URL", "LOG_LEVEL", "NODE_ENV", "PORT", "TLS_VERIFY"],
    });
    expect(stdout).not.toContain("tok-child-ok-0009");
  });

  it("exits non-zero on bad env, naming every bad key and leaking no value", () => {
    const leaks = ["tok-child-bad-LEAK", "pw-child-bad-LEAK", "port-LEAK"];
    const { status, stdout, stderr } = runApp({
      NODE_ENV: "production",
      PORT: "port-LEAK",
      API_TOKEN: "",
      DATABASE_URL: "mysql://bw:pw-child-bad-LEAK@localhost/bw",
      UNRELATED_SECRET: "tok-child-bad-LEAK",
    });
    expect(status).toBe(CONFIG_EXIT_CODE);
    expect(stdout).toBe("");
    const report = JSON.parse(stderr.trim()) as { level: string; msg: string; code: string; issues: unknown };
    expect(report).toEqual({
      level: "fatal",
      name: "@blackwing/config",
      msg: "config.invalid",
      code: "CONFIG_INVALID",
      issues: [
        { key: "DATABASE_URL", reason: "invalid", message: "must use one of the schemes: postgres:, postgresql:" },
        { key: "PORT", reason: "invalid", message: "must be an integer port between 1 and 65535 (digits only)" },
        { key: "API_TOKEN", reason: "empty", message: "required but empty" },
      ],
    });
    for (const leak of leaks) {
      expect(stderr).not.toContain(leak);
    }
  });

  it("exits non-zero when NODE_ENV itself is missing", () => {
    const { status, stderr } = runApp({ PORT: "1", API_TOKEN: "t", DATABASE_URL: "postgres://localhost/bw" });
    expect(status).toBe(CONFIG_EXIT_CODE);
    expect(stderr).toContain('"key":"NODE_ENV","reason":"missing"');
  });
});
