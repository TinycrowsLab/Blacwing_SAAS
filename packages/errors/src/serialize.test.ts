import { describe, expect, it } from "vitest";

import { NotFoundError, ValidationError } from "./app-error.js";
import { REDACTED } from "./redaction.js";
import { MAX_CAUSE_DEPTH, serializeErrorForLog } from "./serialize.js";

describe("serializeErrorForLog", () => {
  it("keeps name, code, detail, stack and the cause chain, all redacted", () => {
    const cause = new Error("upstream said bwk_live_key");
    const error = new ValidationError("bad", { detail: "detail with s3cret", cause });
    const out = serializeErrorForLog(error, (text) => text.replaceAll("s3cret", REDACTED));
    expect(out.name).toBe("ValidationError");
    expect(out.code).toBe("VALIDATION_FAILED");
    expect(out.detail).toBe(`detail with ${REDACTED}`);
    expect(out.stack).toContain("ValidationError: bad");
    expect(out.cause).toMatchObject({ name: "Error", message: `upstream said ${REDACTED}` });
    expect(out.cause?.stack).not.toContain("bwk_live_key");
  });

  it.each([
    ["a string", "token bw_pat_abc", { name: "string", message: `token ${REDACTED}` }],
    ["undefined", undefined, { name: "undefined", message: "undefined" }],
    ["null", null, { name: "null", message: "null" }],
    ["a number", 7, { name: "number", message: "7" }],
    ["a symbol", Symbol("s"), { name: "symbol", message: "Symbol(s)" }],
    ["an object", { a: 1 }, { name: "object", message: '{"a":1}' }],
    ["a BigInt holder", { n: 1n }, { name: "object", message: "[object Object]" }],
  ])("renders %s safely", (_label, value, expected) => {
    expect(serializeErrorForLog(value)).toEqual(expected);
  });

  it("truncates a long thrown value before logging it", () => {
    const out = serializeErrorForLog({ blob: "x".repeat(10_000) });
    expect(out.message.length).toBeLessThanOrEqual(2048);
  });

  it("stops at the maximum cause depth", () => {
    let error: Error = new Error("root");
    for (let i = 0; i < MAX_CAUSE_DEPTH + 5; i += 1) error = new Error(`level ${i}`, { cause: error });
    let link = serializeErrorForLog(error);
    let depth = 1;
    while (link.cause !== undefined) {
      link = link.cause;
      depth += 1;
    }
    expect(depth).toBe(MAX_CAUSE_DEPTH);
    expect(link.truncated).toBe("depth");
  });

  it("marks a self-referencing cause as a cycle", () => {
    const error = new NotFoundError("x");
    Object.defineProperty(error, "cause", { value: error });
    expect(serializeErrorForLog(error).truncated).toBe("cycle");
  });

  it("replaces text with the marker when the redactor fails, and never throws", () => {
    const out = serializeErrorForLog(new Error("maybe secret"), () => {
      throw new Error("x");
    });
    expect(out.message).toBe(REDACTED);
    expect(out.stack).toBe(REDACTED);

    const hostile = new Proxy(new Error("x"), {
      get() {
        throw new Error("trap");
      },
    });
    expect(() => serializeErrorForLog(hostile)).not.toThrow();
  });
});
