// Type tests: checked by `tsc -b` (pnpm typecheck), which fails on any wrong expectation below;
// Vitest also runs the file (expectTypeOf is a no-op at runtime).
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { zBool, zCsv, zDurationMs, zPort, zSecret, zSecretUrl, zString, zUrl } from "./coerce.js";
import { defineConfig, loadConfig } from "./env.js";
import type { Secret } from "./redaction.js";
import { type BaseEnv, baseEnvSchema, databaseEnvShape, type LogLevel, type NodeEnv } from "./schema.js";

const schema = baseEnvSchema.extend({
  ...databaseEnvShape,
  PORT: zPort(),
  DEBUG: zBool().default(false),
  TIMEOUT: zDurationMs().optional(),
  HOSTS: zCsv(),
  PORTS: zCsv(zPort()),
  ROLES: zCsv(z.enum(["read", "write"])),
  API_TOKEN: zSecret(),
  WEBHOOK: zSecretUrl(),
  PUBLIC_URL: zUrl(),
  NAME: zString({ trim: true }),
});

const source = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/bw",
  PORT: "1",
  HOSTS: "a",
  PORTS: "1",
  ROLES: "read",
  API_TOKEN: "tok-types-0010",
  WEBHOOK: "https://hooks.test/x",
  PUBLIC_URL: "https://app.test",
  NAME: "n",
};

describe("type inference", () => {
  it("infers every field of the loaded config exactly, with no any", () => {
    const config = loadConfig(schema, source);
    expectTypeOf(config).not.toBeAny();
    expectTypeOf(config).toEqualTypeOf<
      Readonly<{
        NODE_ENV: NodeEnv;
        LOG_LEVEL: LogLevel;
        OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
        TLS_VERIFY: boolean;
        DATABASE_URL: Secret;
        PORT: number;
        DEBUG: boolean;
        TIMEOUT?: number | undefined;
        HOSTS: readonly string[];
        PORTS: readonly number[];
        ROLES: readonly ("read" | "write")[];
        API_TOKEN: Secret;
        WEBHOOK: Secret;
        PUBLIC_URL: string;
        NAME: string;
      }>
    >();
    expectTypeOf(config.NODE_ENV).toEqualTypeOf<"development" | "test" | "staging" | "production">();
    expectTypeOf(config.PORT).toEqualTypeOf<number>();
    expectTypeOf(config.API_TOKEN).not.toBeAny();
  });

  it("defineConfig infers the same type as loadConfig", () => {
    const config = defineConfig(schema, { source });
    expectTypeOf(config).toEqualTypeOf<ReturnType<typeof loadConfig<z.output<typeof schema>>>>();
    expectTypeOf(defineConfig(baseEnvSchema, { source })).toEqualTypeOf<Readonly<BaseEnv>>();
  });

  it("brands secrets so a plain string cannot pose as one", () => {
    const config = loadConfig(schema, source);
    expectTypeOf(config.API_TOKEN).toExtend<string>();
    expectTypeOf<string>().not.toExtend<Secret>();
    expectTypeOf(config.PUBLIC_URL).not.toExtend<Secret>();
  });

  it("returns a readonly object", () => {
    const config = loadConfig(schema, source);
    expect(() => {
      // @ts-expect-error: config is Readonly
      config.PORT = 2;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error: list values are readonly arrays
      config.HOSTS.push("b");
    }).toThrow(TypeError);
  });
});
