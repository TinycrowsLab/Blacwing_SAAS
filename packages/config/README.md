# @blackwing/config

Typed, fail-fast environment configuration (FOUND-007). CONTEXT_PACK §5 requires every external input to be
validated with Zod at the boundary, and the environment is the first one. **Nothing outside this package reads
`process.env`.** Each app defines its own schema slice from the pieces here and parses it once, at import.

```ts
// apps/api/src/config.ts
import { baseEnvSchema, databaseEnvShape, defineConfig, valkeyEnvShape, zDurationMs, zPort, zSecret } from "@blackwing/config";

export const config = defineConfig(
  baseEnvSchema.extend({
    ...databaseEnvShape,
    ...valkeyEnvShape,
    PORT: zPort().default(13400),
    REQUEST_TIMEOUT: zDurationMs().default(30_000),
    BROKER_SIGNING_KEY: zSecret(),
  }),
);
// config.PORT: number, config.BROKER_SIGNING_KEY: Secret, config.NODE_ENV: "development" | "test" | ...
```

Import the app's `config.ts` first in its entry point, before creating the logger or any database client.

## API

| Export | Does |
|---|---|
| `defineConfig(schema, { source?, onInvalid?, log? })` | Bootstrap entry point. Parses `process.env` (or `source`) and returns the deeply frozen, fully typed config. On invalid config it **fails closed**: writes one JSON line (`msg: "config.invalid"`, key names only) to stderr and exits with `CONFIG_EXIT_CODE` (78, sysexits `EX_CONFIG`). Under `NODE_ENV=test`, or with `onInvalid: "throw"`, it throws instead. |
| `loadConfig(schema, source = process.env, { log? })` | The parser underneath. Always throws `ConfigValidationError` on failure. |
| `ConfigValidationError` | `code: "CONFIG_INVALID"`, `httpStatus: 500`, `retryable: false`, `issues` (`{ key, reason: "missing" \| "empty" \| "invalid", message }`), `missingKeys`, `invalidKeys`. Reports **every** failing key at once. It extends `AppError` once `@blackwing/errors` (#11) lands. |
| `baseEnvSchema` / `baseEnvShape` | Keys every process reads: `NODE_ENV` (required, no default), `LOG_LEVEL` (default `info`), `OTEL_EXPORTER_OTLP_ENDPOINT` (optional, http/https), `TLS_VERIFY` (default `true`). |
| `databaseEnvSchema` / `databaseEnvShape` | `DATABASE_URL` (`postgres:`/`postgresql:`, secret). |
| `valkeyEnvSchema` / `valkeyEnvShape` | `REDIS_URL` (`redis:`/`rediss:`, secret). |
| `zBool()` | `true`/`false` (any case) or `1`/`0`. |
| `zPort()` | Digits only, no leading zero, 1..65535. |
| `zDurationMs()` | Milliseconds: `1500`, `250ms`, `30s`, `5m`, `2h`, `1d`. Integers only. |
| `zUrl({ protocols? })` | Absolute URL, returned verbatim. An embedded password is registered for redaction. |
| `zSecretUrl({ protocols? })` | Like `zUrl`, and the whole URL is a `Secret`. |
| `zSecret()` | Non-empty secret, kept verbatim, registered for redaction, branded `Secret`. |
| `zCsv(item?)` | Comma-separated list. Items are trimmed and must be non-empty; `item` validates each one (`zCsv(zPort())`). Frozen `readonly` array. |
| `zString({ trim? })` | Non-empty string; trimmed only with `trim: true`. |
| `safeMessage(msg)` | Marks a `.refine()` message as constant so it appears in errors (see below). |
| `markSecret`, `unmarkSecret`, `isMarkedSecret`, `redactionRegistry` | The redaction registry. |
| `drainConfigLoadEvents()` | Buffered `config.loaded` events for the logger. |

Base keys are minimal on purpose. A key belongs in the base only if every process needs it, including the
in-sandbox agent runtime, which must never receive database or Valkey credentials (§8.7). Apps add the shared
slices they need. Compose with `.extend({ ...shape })` or `.merge(schema)`.

## Rules

- **Empty means unset.** A key set to `""` is treated as not set. A required key reports reason `empty`, and an
  optional key takes its default. A security toggle set to `""` therefore keeps its secure default.
- **All problems at once.** Every missing and invalid key is collected into one error, never first-fail only.
- **No values in errors.** Messages are rebuilt from the schema (bounds, accepted options, schemes), never from
  the input or from Zod's free-form text. A custom `.refine()` message is replaced by `failed validation` unless
  it is wrapped in `safeMessage("...")`. Never interpolate the value into a safe message. The error has no
  `cause`.
- **Whitespace.** Nothing is trimmed unless declared: `zString({ trim: true })` and `zCsv` items. Ports,
  booleans, durations and URLs with surrounding whitespace are rejected. Secrets are kept byte-for-byte.
- **Secure defaults.** No default may weaken security. `NODE_ENV` has no default, and `TLS_VERIFY` defaults to `true`.
- **Frozen.** The result is deeply frozen, and its type is `Readonly<...>` with `readonly` arrays.

## Secrets and redaction (§8.7)

`zSecret()`, `zSecretUrl()` and the password part of any `zUrl()` value are added to the process-wide redaction
registry while the schema parses, so they are registered before `loadConfig` returns and before any logger
exists. `@blackwing/logger` (FOUND-008, #10) reads `redactionRegistry` (`has`, `values()`, `size`, `version`) and
replaces every registered value, including substrings, with `[REDACTED]`. Use `markSecret` for secrets that
arrive at runtime and `unmarkSecret` when they are revoked. Values are stored verbatim, and the empty string is
never registered.

If parsing fails, secrets that did parse stay registered. Over-redaction is the safe side.

`Secret` is a type-only brand (`string & z.$brand<"Secret">`). Brand secrets with `zSecret()`/`zSecretUrl()`,
not a bare `.brand("Secret")`: a Zod brand has no runtime effect and would not register the value.

## Observability

A successful load emits one `config.loaded` debug event: `{ nodeEnv, keys }` with the sorted top-level key
names and never a value. Config resolves before the logger exists, so by default the event is buffered (at most
32), and the logger drains it with `drainConfigLoadEvents()` once it starts. Pass `log` (anything with pino's
`debug(obj, msg)` signature) to emit it directly. No environment dump is ever logged.

## Tests

`pnpm --filter @blackwing/config test` runs the unit tests and a child-process smoke test. The smoke test boots
`src/testdata/bootstrap-app.ts` with a good environment (exit 0) and with bad ones (exit 78, key names on
stderr, no values). `src/types.test.ts` holds the type-inference tests, which `pnpm typecheck` enforces.
