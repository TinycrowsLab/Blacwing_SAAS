import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as errors from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

describe("@blackwing/errors", () => {
  it("exports its scoped workspace name", () => {
    expect(errors.name).toBe("@blackwing/errors");
    expect(errors.name).toBe(manifest.name);
  });

  it("exports a version matching package.json", () => {
    expect(errors.version).toBe(manifest.version);
  });

  it("exposes the public API from the package entry point", () => {
    for (const exported of [
      "AppError",
      "ValidationError",
      "AuthError",
      "ForbiddenError",
      "NotFoundError",
      "ConflictError",
      "PreconditionFailedError",
      "RateLimitedError",
      "IllegalRunTransitionError",
      "TenantContextMissingError",
      "KillSwitchActiveError",
      "ScopeViolationError",
      "InternalError",
      "isAppError",
      "ERROR_CODES",
      "ERROR_CODE_LIST",
      "isErrorCode",
      "httpStatusFor",
      "problemTypeFor",
      "toProblemDetails",
      "toProblemResponse",
      "createProblemDetailsMapper",
      "PROBLEM_JSON_CONTENT_TYPE",
      "serializeErrorForLog",
      "redactBuiltinSecrets",
      "containsStackTrace",
    ]) {
      expect(errors).toHaveProperty(exported);
    }
  });
});
