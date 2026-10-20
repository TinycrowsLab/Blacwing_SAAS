import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zBool, zCsv, zDurationMs, zPort, zSecret, zSecretUrl, zString, zUrl } from "./coerce.js";
import { describeIssue } from "./issues.js";
import { isMarkedSecret } from "./redaction.js";

function messages(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map(describeIssue);
}

describe("zBool", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["1", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
  ])("parses %j as %s", (input, expected) => {
    expect(zBool().parse(input)).toBe(expected);
  });

  it.each(["yes", "no", "on", "off", "2", "-1", "truee", " true", "true ", "t", ""])(
    "rejects malformed %j with a precise message",
    (input) => {
      expect(messages(zBool(), input)).toEqual(["must be one of: true, false, 1, 0"]);
    },
  );
});

describe("zPort", () => {
  it.each([
    ["1", 1],
    ["80", 80],
    ["13400", 13_400],
    ["65535", 65_535],
  ])("parses %j", (input, expected) => {
    expect(zPort().parse(input)).toBe(expected);
  });

  it.each(["0", "65536", "99999", "100000", "-1", "+80", "080", "8.0", "1e3", "0x50", " 80", "80 ", "eighty", "８０"])(
    "rejects malformed %j with a precise message",
    (input) => {
      expect(messages(zPort(), input)).toEqual(["must be an integer port between 1 and 65535 (digits only)"]);
    },
  );
});

describe("zDurationMs", () => {
  it.each([
    ["0", 0],
    ["1500", 1500],
    ["250ms", 250],
    ["30s", 30_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("parses %j as %d ms", (input, expected) => {
    expect(zDurationMs().parse(input)).toBe(expected);
  });

  it.each(["-1", "1.5s", "1.5", "5 m", " 5m", "5m ", "5M", "5min", "1h30m", "s", "ms", "abc", "1e3"])(
    "rejects malformed %j with a precise message",
    (input) => {
      expect(messages(zDurationMs(), input)).toEqual([
        "must be a non-negative integer duration: plain milliseconds or a number with unit ms, s, m, h or d",
      ]);
    },
  );

  it("rejects durations beyond the safe-integer range", () => {
    expect(messages(zDurationMs(), "999999999999999999d")).toEqual([
      "is too large to represent as a safe integer number of milliseconds",
    ]);
  });
});

describe("zUrl", () => {
  it("returns the URL verbatim", () => {
    expect(zUrl().parse("http://localhost:14318/v1")).toBe("http://localhost:14318/v1");
  });

  it("restricts schemes when asked", () => {
    const schema = zUrl({ protocols: ["https:"] });
    expect(schema.parse("https://example.test")).toBe("https://example.test");
    expect(messages(schema, "http://example.test")).toEqual(["must use one of the schemes: https:"]);
  });

  it.each(["not a url", "example.test/path", "/relative/path", "http://"])("rejects %j", (input) => {
    expect(messages(zUrl(), input)).toEqual(["must be an absolute URL"]);
  });

  it("rejects surrounding whitespace instead of silently trimming it", () => {
    expect(messages(zUrl(), " http://localhost ")).toEqual(["must not have leading or trailing whitespace"]);
  });

  it("registers an embedded password (raw and decoded) for redaction", () => {
    zUrl().parse("redis://user:p%40ss-zurl-embedded@localhost:16379");
    expect(isMarkedSecret("p%40ss-zurl-embedded")).toBe(true);
    expect(isMarkedSecret("p@ss-zurl-embedded")).toBe(true);
    expect(isMarkedSecret("user")).toBe(false);
  });

  it("registers an embedded password even when the scheme is then rejected", () => {
    expect(messages(zUrl({ protocols: ["https:"] }), "ftp://u:pw-rejected-scheme@host")).toHaveLength(1);
    expect(isMarkedSecret("pw-rejected-scheme")).toBe(true);
  });
});

describe("zSecretUrl", () => {
  it("registers the whole URL and returns it verbatim", () => {
    const url = "postgres://bw:pw-secret-url@localhost:15432/blackwing";
    expect(zSecretUrl({ protocols: ["postgres:"] }).parse(url)).toBe(url);
    expect(isMarkedSecret(url)).toBe(true);
    expect(isMarkedSecret("pw-secret-url")).toBe(true);
  });

  it("does not register a URL that fails validation", () => {
    const url = "mysql://host-only-secret-url";
    expect(messages(zSecretUrl({ protocols: ["postgres:"] }), url)).toEqual(["must use one of the schemes: postgres:"]);
    expect(isMarkedSecret(url)).toBe(false);
  });
});

describe("zSecret", () => {
  it("registers the value for redaction and keeps it verbatim (no trim, no normalisation)", () => {
    const value = "  späced ☃ secret\t";
    expect(zSecret().parse(value)).toBe(value);
    expect(isMarkedSecret(value)).toBe(true);
    expect(isMarkedSecret(value.trim())).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(messages(zSecret(), "")).toEqual(["must be at least 1 character long"]);
  });
});

describe("zString", () => {
  it("keeps whitespace by default", () => {
    expect(zString().parse("  value  ")).toBe("  value  ");
    expect(messages(zString(), "")).toEqual(["must be at least 1 character long"]);
  });

  it("trims only when declared, and then rejects blank values", () => {
    expect(zString({ trim: true }).parse("  value  ")).toBe("value");
    expect(messages(zString({ trim: true }), " \t ")).toEqual(["must not be blank"]);
  });
});

describe("zCsv", () => {
  it("splits and trims items into a frozen array", () => {
    const list = zCsv().parse("a, b ,c");
    expect(list).toEqual(["a", "b", "c"]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("validates each item with the given schema", () => {
    const schema = zCsv(z.enum(["read", "write"]));
    expect(schema.parse("read,write")).toEqual(["read", "write"]);
    const result = schema.safeParse("read,admin");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[1]]);
  });

  it("composes with other coercion helpers", () => {
    expect(zCsv(zPort()).parse("80, 443")).toEqual([80, 443]);
    expect(zCsv(zPort()).safeParse("80,http").success).toBe(false);
  });

  it.each(["a,,b", "a,", ",a", "a, ,b"])("rejects the empty item in %j", (input) => {
    expect(messages(zCsv(), input)).toEqual(["must be at least 1 character long"]);
  });

  it("reports every empty item, not only the first", () => {
    const result = zCsv().safeParse(" , ,a");
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[0], [1]]);
  });
});
