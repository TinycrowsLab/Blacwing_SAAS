import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { zBool, zCsv, zDurationMs, zPort, zSecret, zString, zUrl } from "./coerce.js";
import { CONFIG_EXIT_CODE, defineConfig, loadConfig } from "./env.js";
import { ConfigValidationError, isConfigValidationError } from "./errors.js";
import { type ConfigLogSink, drainConfigLoadEvents, MAX_BUFFERED_CONFIG_EVENTS } from "./events.js";
import { safeMessage } from "./issues.js";
import { isMarkedSecret, redactionRegistry } from "./redaction.js";
import { baseEnvSchema, databaseEnvSchema, databaseEnvShape, valkeyEnvSchema } from "./schema.js";

/** Runs `fn`, asserts it throws a ConfigValidationError, and returns it. */
function captureConfigError(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigValidationError");
}

/** Every way an error could be rendered: message, stack, JSON, util.inspect. */
function renderings(error: ConfigValidationError): string[] {
  return [error.message, String(error.stack), JSON.stringify(error), inspect(error, { depth: 10 }), String(error)];
}

function expectNoValues(error: ConfigValidationError, values: readonly string[]): void {
  for (const rendering of renderings(error)) {
    for (const value of values) {
      expect(rendering).not.toContain(value);
    }
  }
}

afterEach(() => {
  drainConfigLoadEvents();
  vi.restoreAllMocks();
});

const appSchema = baseEnvSchema.extend({
  PORT: zPort(),
  API_TOKEN: zSecret(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64),
});

describe("loadConfig: valid input", () => {
  it("parses, coerces and applies secure defaults", () => {
    const config = loadConfig(appSchema, {
      NODE_ENV: "production",
      PORT: "13400",
      API_TOKEN: "tok-valid-case-0001",
      WORKER_CONCURRENCY: "8",
      UNRELATED: "ignored",
    });
    expect(config).toEqual({
      NODE_ENV: "production",
      LOG_LEVEL: "info",
      TLS_VERIFY: true,
      PORT: 13_400,
      API_TOKEN: "tok-valid-case-0001",
      WORKER_CONCURRENCY: 8,
    });
    expect(config).not.toHaveProperty("UNRELATED");
  });

  it("returns a deeply frozen object", () => {
    const config = loadConfig(z.object({ HOSTS: zCsv(), NESTED: z.object({ a: z.string() }).optional() }), {
      HOSTS: "a,b",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.HOSTS)).toBe(true);
    expect(() => {
      (config as { HOSTS: unknown }).HOSTS = [];
    }).toThrow(TypeError);
  });

  it("deep-freezes nested objects produced by the schema", () => {
    const schema = z.object({ A: z.string() }).transform((env) => ({ nested: { a: env.A } }));
    const config = loadConfig(schema, { A: "x" });
    expect(Object.isFrozen(config.nested)).toBe(true);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("BW_CONFIG_TEST_DEFAULT_SOURCE", "from-process-env");
    const config = loadConfig(z.object({ BW_CONFIG_TEST_DEFAULT_SOURCE: z.string() }));
    expect(config.BW_CONFIG_TEST_DEFAULT_SOURCE).toBe("from-process-env");
    vi.unstubAllEnvs();
  });

  it("composes base and shared slices with .merge() and .extend()", () => {
    const source = {
      NODE_ENV: "development",
      DATABASE_URL: "postgres://bw:pw-merge-db@localhost:15432/bw",
      REDIS_URL: "redis://localhost:16379",
    };
    const merged = loadConfig(baseEnvSchema.merge(databaseEnvSchema).merge(valkeyEnvSchema), source);
    const extended = loadConfig(baseEnvSchema.extend(databaseEnvShape).extend(valkeyEnvSchema.shape), source);
    expect(merged).toEqual(extended);
    expect(merged.DATABASE_URL).toBe(source.DATABASE_URL);
  });

  it("does not let a __proto__ key reach the prototype", () => {
    const source: Record<string, string> = {};
    Object.defineProperty(source, "__proto__", { value: "polluted", enumerable: true });
    const config = loadConfig(z.object({ A: z.string().optional() }), source);
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });
});

describe("loadConfig: missing and empty keys", () => {
  it("throws listing every missing key at once, with zero values leaked", () => {
    const values = ["tok-should-not-leak-0002", "production"];
    const error = captureConfigError(() =>
      loadConfig(appSchema, { NODE_ENV: "production", API_TOKEN: "tok-should-not-leak-0002" }),
    );
    expect(error.missingKeys).toEqual(["PORT", "WORKER_CONCURRENCY"]);
    expect(error.invalidKeys).toEqual([]);
    expect(error.issues).toEqual([
      { key: "PORT", reason: "missing", message: "required but not set" },
      { key: "WORKER_CONCURRENCY", reason: "missing", message: "required but not set" },
    ]);
    expect(error.message).toContain("PORT: required but not set");
    expect(error.message).toContain("WORKER_CONCURRENCY: required but not set");
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.httpStatus).toBe(500);
    expect(error.retryable).toBe(false);
    expect(error.name).toBe("ConfigValidationError");
    expect(error.cause).toBeUndefined();
    expect(isConfigValidationError(error)).toBe(true);
    expect(isConfigValidationError(new Error("x"))).toBe(false);
    expectNoValues(error, values);
  });

  it("treats an empty required string as invalid (reason 'empty'), distinct from unset", () => {
    const error = captureConfigError(() => loadConfig(z.object({ A: z.string(), B: z.string() }), { A: "" }));
    expect(error.issues).toEqual([
      { key: "A", reason: "empty", message: "required but empty" },
      { key: "B", reason: "missing", message: "required but not set" },
    ]);
    expect(error.missingKeys).toEqual(["A", "B"]);
    expect(error.message).toContain("A: required but empty (an empty value counts as unset)");
  });

  it("lets an optional key set to the empty string take its default", () => {
    const config = loadConfig(z.object({ LEVEL: z.string().default("info"), OPT: z.string().optional() }), {
      LEVEL: "",
      OPT: "",
    });
    expect(config).toEqual({ LEVEL: "info" });
  });

  it("keeps security defaults when a toggle is set to the empty string", () => {
    const config = loadConfig(baseEnvSchema, { NODE_ENV: "production", TLS_VERIFY: "" });
    expect(config.TLS_VERIFY).toBe(true);
  });
});

describe("loadConfig: invalid values", () => {
  const secretValues = ["not-a-port-LEAK", "maybe-LEAK", "verbose-LEAK", "1.5h-LEAK", "ftp://u:pw-LEAK@x", "tok-LEAK"];

  it("reports every invalid key at once with precise messages and no values", () => {
    const schema = baseEnvSchema.extend({
      PORT: zPort(),
      FLAG: zBool(),
      TIMEOUT: zDurationMs(),
      ENDPOINT: zUrl({ protocols: ["https:"] }),
      API_TOKEN: zSecret(),
    });
    const error = captureConfigError(() =>
      loadConfig(schema, {
        NODE_ENV: "verbose-LEAK",
        LOG_LEVEL: "maybe-LEAK",
        PORT: "not-a-port-LEAK",
        FLAG: "maybe-LEAK",
        TIMEOUT: "1.5h-LEAK",
        ENDPOINT: "ftp://u:pw-LEAK@x",
        API_TOKEN: "tok-LEAK",
      }),
    );
    expect(error.issues).toEqual([
      {
        key: "NODE_ENV",
        reason: "invalid",
        message: 'must be one of: "development", "test", "staging", "production"',
      },
      {
        key: "LOG_LEVEL",
        reason: "invalid",
        message: 'must be one of: "fatal", "error", "warn", "info", "debug", "trace", "silent"',
      },
      { key: "PORT", reason: "invalid", message: "must be an integer port between 1 and 65535 (digits only)" },
      { key: "FLAG", reason: "invalid", message: "must be one of: true, false, 1, 0" },
      {
        key: "TIMEOUT",
        reason: "invalid",
        message: "must be a non-negative integer duration: plain milliseconds or a number with unit ms, s, m, h or d",
      },
      { key: "ENDPOINT", reason: "invalid", message: "must use one of the schemes: https:" },
    ]);
    expect(error.invalidKeys).toEqual(["NODE_ENV", "LOG_LEVEL", "PORT", "FLAG", "TIMEOUT", "ENDPOINT"]);
    expect(error.message.startsWith("Invalid configuration: 6 problems\n")).toBe(true);
    expectNoValues(error, secretValues);
  });

  it("reports missing and invalid keys together", () => {
    const error = captureConfigError(() => loadConfig(appSchema, { NODE_ENV: "production", PORT: "0" }));
    expect(error.missingKeys).toEqual(["API_TOKEN", "WORKER_CONCURRENCY"]);
    expect(error.invalidKeys).toEqual(["PORT"]);
  });

  it("rewrites Zod's own messages so they cannot echo input", () => {
    const schema = z.object({
      COUNT: z.coerce.number().int().min(1),
      NAME: z.string().max(3),
      EMAIL: z.email(),
      PREFIXED: z.string().startsWith("bwk_"),
      SUFFIXED: z.string().endsWith(".internal"),
      CONTAINS: z.string().includes("@"),
      PATTERN: z.string().regex(/^tok-[0-9]{4}$/),
    });
    const error = captureConfigError(() =>
      loadConfig(schema, {
        COUNT: "nope-LEAK",
        NAME: "toolong-LEAK",
        EMAIL: "x-LEAK",
        PREFIXED: "tok-LEAK",
        SUFFIXED: "sfx-LEAK",
        CONTAINS: "inc-LEAK",
        PATTERN: "re-LEAK",
      }),
    );
    expect(error.issues.map((issue) => [issue.key, issue.message])).toEqual([
      ["COUNT", "expected number"],
      ["NAME", "must be at most 3 characters long"],
      ["EMAIL", "must be a valid email"],
      ["PREFIXED", "must start with \"bwk_\""],
      ["SUFFIXED", "must end with \".internal\""],
      ["CONTAINS", "must include \"@\""],
      ["PATTERN", "must match the required pattern"],
    ]);
    // "tok-[" also proves the regex source is not printed.
    const leaks = ["nope-LEAK", "toolong-LEAK", "x-LEAK", "tok-LEAK", "sfx-LEAK", "inc-LEAK", "re-LEAK", "tok-["];
    expectNoValues(error, leaks);
  });

  it("describes exact lengths and list sizes precisely", () => {
    const schema = z.object({
      CODE: z.string().length(3),
      SHORT: z.string().length(4),
      ONE: z.string().max(1),
      HOSTS: zCsv().pipe(z.array(z.string()).min(2)),
      PAIR: zCsv().pipe(z.array(z.string()).length(2)),
    });
    const error = captureConfigError(() =>
      loadConfig(schema, { CODE: "long-LEAK", SHORT: "ab", ONE: "ab-LEAK", HOSTS: "a-LEAK", PAIR: "a,b,c-LEAK" }),
    );
    expect(error.issues.map((issue) => [issue.key, issue.message])).toEqual([
      ["CODE", "must be exactly 3 characters long"],
      ["SHORT", "must be exactly 4 characters long"],
      ["ONE", "must be at most 1 character long"],
      ["HOSTS", "must have at least 2 items"],
      ["PAIR", "must have exactly 2 items"],
    ]);
    expectNoValues(error, ["long-LEAK", "ab-LEAK", "a-LEAK", "c-LEAK"]);
  });

  it("drops free-form refinement messages unless marked safe", () => {
    const schema = z
      .object({
        UNSAFE: z.string().refine((v) => v === "ok", { message: "got a bad value" }),
        SAFE: z.string().refine((v) => v === "ok", safeMessage("must be ok")),
        A: z.string(),
        B: z.string(),
      })
      .refine((env) => env.A !== env.B, safeMessage("A and B must differ"));
    const unsafe = captureConfigError(() => loadConfig(schema, { UNSAFE: "bad", SAFE: "bad", A: "x", B: "y" }));
    expect(unsafe.issues).toEqual([
      { key: "UNSAFE", reason: "invalid", message: "failed validation" },
      { key: "SAFE", reason: "invalid", message: "must be ok" },
    ]);
    const root = captureConfigError(() => loadConfig(schema, { UNSAFE: "ok", SAFE: "ok", A: "x", B: "x" }));
    expect(root.issues).toEqual([{ key: "(root)", reason: "invalid", message: "A and B must differ" }]);
  });

  it("names nested paths for list items", () => {
    const schema = z.object({ PORTS: zCsv(zPort()) });
    const error = captureConfigError(() => loadConfig(schema, { PORTS: "80,http-LEAK,443,0" }));
    expect(error.issues).toEqual([
      { key: "PORTS[1]", reason: "invalid", message: "must be an integer port between 1 and 65535 (digits only)" },
      { key: "PORTS[3]", reason: "invalid", message: "must be an integer port between 1 and 65535 (digits only)" },
    ]);
    expectNoValues(error, ["http-LEAK"]);
  });

  it("fails closed on schemas that need async parsing", () => {
    const schema = z.object({ A: z.string().refine(async () => Promise.resolve(true)) });
    expect(() => loadConfig(schema, { A: "x" })).toThrow();
  });
});

describe("loadConfig: whitespace and Unicode", () => {
  it("preserves secrets verbatim and trims only where declared", () => {
    const schema = z.object({ SECRET: zSecret(), NAME: zString({ trim: true }), RAW: zString() });
    const secret = " ünïcödé \u{1F511} secret ";
    const config = loadConfig(schema, { SECRET: secret, NAME: "  blackwing\n", RAW: " raw " });
    expect(config.SECRET).toBe(secret);
    expect(config.NAME).toBe("blackwing");
    expect(config.RAW).toBe(" raw ");
  });

  it("rejects numeric and boolean values with surrounding whitespace", () => {
    const error = captureConfigError(() =>
      loadConfig(z.object({ PORT: zPort(), FLAG: zBool(), TIMEOUT: zDurationMs() }), {
        PORT: " 80",
        FLAG: "true ",
        TIMEOUT: "\t5s",
      }),
    );
    expect(error.invalidKeys).toEqual(["PORT", "FLAG", "TIMEOUT"]);
  });
});

describe("loadConfig: base schema security defaults", () => {
  it("requires NODE_ENV (no default that would enable dev behaviour)", () => {
    const error = captureConfigError(() => loadConfig(baseEnvSchema, {}));
    expect(error.missingKeys).toEqual(["NODE_ENV"]);
  });

  it("defaults TLS_VERIFY to true and honours an explicit value", () => {
    expect(loadConfig(baseEnvSchema, { NODE_ENV: "production" }).TLS_VERIFY).toBe(true);
    expect(loadConfig(baseEnvSchema, { NODE_ENV: "development", TLS_VERIFY: "false" }).TLS_VERIFY).toBe(false);
  });

  it("accepts an OTLP endpoint only over http(s)", () => {
    const ok = loadConfig(baseEnvSchema, { NODE_ENV: "test", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:14318" });
    expect(ok.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:14318");
    const error = captureConfigError(() =>
      loadConfig(baseEnvSchema, { NODE_ENV: "test", OTEL_EXPORTER_OTLP_ENDPOINT: "grpc://localhost:14317" }),
    );
    expect(error.invalidKeys).toEqual(["OTEL_EXPORTER_OTLP_ENDPOINT"]);
  });

  it("restricts DATABASE_URL and REDIS_URL schemes", () => {
    const error = captureConfigError(() =>
      loadConfig(databaseEnvSchema.merge(valkeyEnvSchema), {
        DATABASE_URL: "mysql://localhost/db",
        REDIS_URL: "http://localhost:16379",
      }),
    );
    expect(error.invalidKeys).toEqual(["DATABASE_URL", "REDIS_URL"]);
  });
});

describe("loadConfig: redaction registration", () => {
  it("registers secret-branded values before it returns", () => {
    const token = "tok-registered-0003";
    const dbUrl = "postgresql://bw:pw-registered-0003@localhost:15432/bw";
    expect(isMarkedSecret(token)).toBe(false);
    const config = loadConfig(appSchema.extend(databaseEnvShape), {
      NODE_ENV: "test",
      PORT: "1",
      API_TOKEN: token,
      WORKER_CONCURRENCY: "1",
      DATABASE_URL: dbUrl,
    });
    expect(redactionRegistry.has(config.API_TOKEN)).toBe(true);
    expect(redactionRegistry.has(token)).toBe(true);
    expect(redactionRegistry.has(dbUrl)).toBe(true);
    expect(redactionRegistry.has("pw-registered-0003")).toBe(true);
    expect(redactionRegistry.values()).toEqual(expect.arrayContaining([token, dbUrl]));
  });

  it("does not register non-secret values", () => {
    loadConfig(baseEnvSchema.extend({ PUBLIC_NAME: zString() }), {
      NODE_ENV: "test",
      PUBLIC_NAME: "public-not-secret-0004",
    });
    expect(isMarkedSecret("public-not-secret-0004")).toBe(false);
    expect(isMarkedSecret("test")).toBe(false);
  });

  it("registers a valid secret even when another key fails (over-redaction is the safe side)", () => {
    captureConfigError(() =>
      loadConfig(appSchema, { NODE_ENV: "test", API_TOKEN: "tok-partial-0005", PORT: "x", WORKER_CONCURRENCY: "1" }),
    );
    expect(isMarkedSecret("tok-partial-0005")).toBe(true);
  });
});

describe("loadConfig: observability", () => {
  it("emits one config.loaded debug event with sorted key names and NODE_ENV, no values", () => {
    const debug = vi.fn<ConfigLogSink["debug"]>();
    loadConfig(
      appSchema,
      { NODE_ENV: "staging", PORT: "1", API_TOKEN: "tok-obs-0006", WORKER_CONCURRENCY: "2" },
      {
        log: { debug },
      },
    );
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      {
        nodeEnv: "staging",
        keys: ["API_TOKEN", "LOG_LEVEL", "NODE_ENV", "PORT", "TLS_VERIFY", "WORKER_CONCURRENCY"],
      },
      "config.loaded",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("tok-obs-0006");
    expect(drainConfigLoadEvents()).toEqual([]);
  });

  it("buffers the event for the logger when no sink is given", () => {
    loadConfig(z.object({ A: z.string() }), { A: "value-not-logged-0007" });
    const events = drainConfigLoadEvents();
    expect(events).toEqual([{ level: "debug", msg: "config.loaded", nodeEnv: undefined, keys: ["A"] }]);
    expect(JSON.stringify(events)).not.toContain("value-not-logged-0007");
    expect(drainConfigLoadEvents()).toEqual([]);
  });

  it("bounds the buffer", () => {
    for (let i = 0; i < MAX_BUFFERED_CONFIG_EVENTS + 5; i += 1) {
      loadConfig(z.object({}), {});
    }
    expect(drainConfigLoadEvents()).toHaveLength(MAX_BUFFERED_CONFIG_EVENTS);
  });

  it("emits nothing on failure", () => {
    const debug = vi.fn<ConfigLogSink["debug"]>();
    captureConfigError(() => loadConfig(baseEnvSchema, {}, { log: { debug } }));
    expect(debug).not.toHaveBeenCalled();
    expect(drainConfigLoadEvents()).toEqual([]);
  });
});

describe("defineConfig", () => {
  it("returns the frozen config on success", () => {
    const config = defineConfig(baseEnvSchema, { source: { NODE_ENV: "production" } });
    expect(config.NODE_ENV).toBe("production");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("throws in tests (raw NODE_ENV=test)", () => {
    const exit = vi.spyOn(process, "exit");
    const error = captureConfigError(() => defineConfig(appSchema, { source: { NODE_ENV: "test", PORT: "x" } }));
    expect(error.missingKeys).toEqual(["API_TOKEN", "WORKER_CONCURRENCY"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("throws when asked to, whatever NODE_ENV says", () => {
    const exit = vi.spyOn(process, "exit");
    const error = captureConfigError(() =>
      defineConfig(appSchema, { source: { NODE_ENV: "production" }, onInvalid: "throw" }),
    );
    expect(error.missingKeys).toEqual(["PORT", "API_TOKEN", "WORKER_CONCURRENCY"]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with CONFIG_EXIT_CODE outside tests (fail closed)", () => {
    class ExitCalled extends Error {}
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new ExitCalled();
    });
    expect(() => defineConfig(appSchema, { source: { NODE_ENV: "production" }, onInvalid: "exit" })).toThrow(
      ExitCalled,
    );
    expect(exit).toHaveBeenCalledWith(CONFIG_EXIT_CODE);
    expect(CONFIG_EXIT_CODE).not.toBe(0);
  });

  it("defaults to exit when NODE_ENV is anything but test", () => {
    class ExitCalled extends Error {}
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new ExitCalled();
    });
    expect(() => defineConfig(baseEnvSchema, { source: {} })).toThrow(ExitCalled);
    expect(() => defineConfig(baseEnvSchema, { source: { NODE_ENV: "nonsense" } })).toThrow(ExitCalled);
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it("rethrows errors that are not config validation errors", () => {
    const boom = new RangeError("schema bug");
    const schema = z.object({
      A: z.string().transform(() => {
        throw boom;
      }),
    });
    const exit = vi.spyOn(process, "exit");
    expect(() => defineConfig(schema, { source: { A: "x" }, onInvalid: "exit" })).toThrow(boom);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("startup ordering", () => {
  it("parses once at module import, with secrets registered before importers run", async () => {
    const before = drainConfigLoadEvents().length;
    expect(before).toBe(0);
    const { config, registeredAtImport } = await import("./testdata/app-config.js");
    expect(config.NODE_ENV).toBe("test");
    expect(registeredAtImport).toBe(true);
    expect(isMarkedSecret(config.APP_SECRET)).toBe(true);
    const again = await import("./testdata/app-config.js");
    expect(again.config).toBe(config);
    expect(drainConfigLoadEvents()).toHaveLength(1);
  });
});
