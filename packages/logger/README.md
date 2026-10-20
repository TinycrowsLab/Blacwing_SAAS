# @blackwing/logger

pino structured JSON logging with secret redaction and OpenTelemetry trace correlation (FOUND-008).
CONTEXT_PACK §5 fixes pino with "no secrets or PII in logs", and §8.7 says known secret values never reach
the logs in plaintext. **This package is the only logging path**: product code never calls `console.*`
(the ESLint `no-console` rule from FOUND-004 enforces it, and a unit test checks this package's own
sources).

```ts
// apps/api/src/main.ts
import { config } from "./config.js"; // @blackwing/config first: it registers every zSecret() value
import { configureLogging, createLogger, withContext } from "@blackwing/logger";

configureLogging({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
export const log = createLogger("api");

const runLog = withContext(log, { tenantId, runId, sessionId });
runLog.info({ req }, "request received");
// {"level":"info","time":"2026-10-20T10:15:30.123Z","pid":7,"name":"api","tenantId":"…","runId":"run_…",
//  "traceId":"4bf9…","spanId":"00f0…","req":{"method":"GET","url":"/v1/runs?api_token=[REDACTED]",
//  "headers":{"authorization":"[REDACTED]",…}},"msg":"request received"}
```

## API

| Export | Does |
|---|---|
| `configureLogging({ level, nodeEnv, maxFieldBytes?, maxDepth?, maxCollectionItems? })` | Process-wide defaults for loggers created afterwards. Pass `config.LOG_LEVEL` and `config.NODE_ENV`. Throws `ValidationError` on a bad value (fail fast at boot). |
| `createLogger(name, options?)` | A named pino logger. `options` overrides the defaults per logger and may set a `destination` stream (tests). The first logger also logs the buffered `config.loaded` events at `debug`. |
| `withContext(logger, { tenantId?, runId?, sessionId?, traceId? })` | A child logger with those fields on every line; its children inherit them. With a `tenantId` it returns a `TenantLogger`. |
| `Logger`, `TenantLogger`, `LogContext`, `TenantLogContext` | Types. Data-path code takes a `TenantLogger`, so the compiler enforces the "data-path logs carry `tenantId`" convention. |
| `redactText(text)` | The value redactor. Inject it as `redact` into the `@blackwing/errors` problem+json mapper. |
| `registerSecretPattern(name, regexp)` | Adds a credential *format* to redact everywhere. Returns a remover. |
| `REDACT_PATHS`, `isSensitiveKey`, `REDACTED`, `TRUNCATED`, `CIRCULAR`, … | The rules and markers below. |
| `activeTraceFields()` | `{ traceId, spanId }` of the active OTel span, or `undefined`. |

## Line format

- One JSON object per line on stdout. Base fields first: `level` (label: `info`, `error`, …), `time`
  (ISO-8601 UTC), `pid`, `name`. No `hostname`: the log pipeline labels lines with pod/node metadata.
- `traceId` and `spanId` come from the active OpenTelemetry span (`@opentelemetry/api`). Outside a span
  they are omitted. Before OpenTelemetry is set up, the API's no-op context manager simply yields no
  span, and a failing context manager is ignored. Logging never throws because of tracing. A
  `withContext({ traceId })` value is the fallback when no span is active, for example in a job that
  carries the trace id of the request that queued it.
- `NODE_ENV=development` uses the pino-pretty transport (a worker thread). Every other environment
  writes JSON straight to stdout, with no transport in the production hot path. Writes are
  synchronous on purpose. With an asynchronous sonic-boom, the `flushSync` that pino does after `fatal`
  could write the fatal line ahead of earlier lines still in flight, and a crash could lose queued
  lines. So `fatal` is on stdout before the call returns and survives an immediate `process.exit`. The
  pretty transport is flushed synchronously after `fatal` too.
- `name` is fixed per logger. A `name` child binding is dropped, so use `component`. Re-binding a key
  (for example `withContext` with another `tenantId`) replaces it. Keys are never duplicated.

## Redaction (§8.7)

Every argument of every log call (merge object, message, format arguments), every child or
`setBindings` binding, a child's `msgPrefix`, and the output of a child's own `serializers` and
`formatters` go through a safe object walk before pino serialises them:

1. **Values.** Every string, keys included, has these replaced with `[REDACTED]`: every value in the
   `@blackwing/config` redaction registry (`zSecret()`, `zSecretUrl()`, URL passwords, `markSecret()`),
   matched as an exact substring, so `http://bwk_…@egress` and query strings are caught; every registered
   secret pattern (built in: `bwk_…` virtual model keys, `bw_pat_…` personal access tokens, `bw_ci_…` CI
   tokens); and the `@blackwing/errors` built-in shapes (`Bearer`/`Basic` values, URL userinfo, PEM
   private keys). Matching is by exact UTF-16 code units: no case folding and no Unicode normalisation.
   Longer secrets are replaced first.
2. **Key names.** The whole value under a sensitive key is replaced at any depth. That covers
   `password`, `secret`, `token`, `apiKey`, `authorization`, `cookie`, `signature`, `privateKey`,
   `credentials`, `secretKey`, `secretAccessKey`, `encryptionKey`, `signingKey`, as exact names or
   suffixes, plus `pwd`, `auth` and `jwt` as exact names, in any case and with `-`, `_` or spaces. For
   example `clientSecret`, `x-api-key`, `AWS_SECRET_ACCESS_KEY` and `set-cookie`. `inputTokens`, `secretRef`, `tokenId` and boolean flags
   stay visible.
3. **pino `redact.paths`** (`REDACT_PATHS`): `password`, `*.password`, `*.token`, `headers.authorization`,
   `req.headers.cookie` and the rest. These apply to anything that reaches pino without passing the walk.
   A child logger's own `redact` option can only add paths.
4. **Safety net.** The serialised line is scanned once more for registry values (raw and JSON-escaped)
   and the registered patterns. This catches a secret that only formed when `%s` joined two pieces. If
   that replacement would break the JSON, the line is replaced by a parseable
   `log line dropped: redaction left it unparseable` notice. It is never written unredacted.

Virtual model keys are registered with `markSecret` when issued and removed with `unmarkSecret` when
revoked (model-gateway epic). The `bwk_` pattern keeps them redacted after revocation too. Use
`registerSecretPattern` for new credential formats. Patterns must not match the empty string and should
be linear, because they run on every line.

## Size and shape limits

| Limit | Default | Behaviour |
|---|---|---|
| `maxFieldBytes` | 8192 | A string longer than this many UTF-8 bytes is cut on a code-point boundary and gets `[truncated]` appended. Redaction runs **before** truncation, so a cut secret leaves no prefix. For speed, only the head of a huge string is redacted: the cut plus enough lookahead for the longest secret. |
| `maxDepth` | 10 | Deeper objects become `[MaxDepth]`. |
| `maxCollectionItems` | 200 | Extra array items, object keys and map/set entries are dropped with a `[truncated]` note. |

Circular references become `[Circular]`. A throwing getter or a hostile proxy becomes
`[Unserializable]`. Errors are serialised with their cause chain (by `@blackwing/errors`
`serializeErrorForLog`) plus their own extra fields. Node `IncomingMessage`/`ServerResponse` objects
become `{ method, url, headers, remoteAddress, remotePort }` / `{ statusCode, headers }`. Binary data is
logged only as `[Binary N bytes]`. `BigInt` becomes a string. A `__proto__` key stays a plain key.

## Tests

`pnpm --filter @blackwing/logger test` runs:

- unit tests for path, value, substring, Unicode and JSON-escaped redaction, plus a fast-check property;
- tests for truncation, circular references, limits, trace correlation with a fake span (and before
  OTel init), levels, child context and `fatal` flushing;
- a child-process suite (`logger.process.test.ts`): a real service logs an HTTP request that carries a
  bearer token, cookies and a query secret to the real stdout, a `fatal` line survives
  `process.exit()`, and pretty output appears in development only. All of it is redacted.
