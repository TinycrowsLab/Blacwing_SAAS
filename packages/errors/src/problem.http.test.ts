import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NotFoundError, RateLimitedError } from "./app-error.js";
import { createProblemDetailsMapper, PROBLEM_JSON_CONTENT_TYPE } from "./problem.js";
import { REDACTED } from "./redaction.js";

/**
 * A minimal HTTP boundary on loopback, standing in for the API exception filter (API epic): it throws
 * per route, maps the error once and writes the problem response. Proves the wire format end to end.
 */
const mapper = createProblemDetailsMapper({ environment: "production", redact: (text) => text.split("hunter2").join(REDACTED) });

function route(path: string | undefined): never {
  if (path === "/missing") throw new NotFoundError("asset lookup failed", { detail: "No asset with that id." });
  if (path === "/limited") throw new RateLimitedError("bucket empty", { retryAfterSeconds: 5 });
  throw new Error(`database exploded at ${path ?? "?"} with password=hunter2`);
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    try {
      route(req.url);
    } catch (err) {
      const { status, headers, body } = mapper.toProblemResponse(err, "0af7651916cd43dd8448eb211c80319c");
      res.writeHead(status, { ...headers });
      res.end(JSON.stringify(body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
});

describe("problem+json over HTTP", () => {
  it("answers a 404 with content-type application/problem+json and the RFC 9457 body", async () => {
    const res = await fetch(`${base}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      type: "https://errors.blackwing.dev/NOT_FOUND",
      title: "Resource not found",
      status: 404,
      detail: "No asset with that id.",
      code: "NOT_FOUND",
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
  });

  it("sends Retry-After on a 429", async () => {
    const res = await fetch(`${base}/limited`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("answers an unexpected failure with a generic 500 that leaks nothing", async () => {
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe(PROBLEM_JSON_CONTENT_TYPE);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      type: "https://errors.blackwing.dev/INTERNAL",
      title: "Internal server error",
      status: 500,
      code: "INTERNAL",
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
    for (const leak of ["hunter2", "database", "stack", "/boom"]) expect(text).not.toContain(leak);
  });
});
