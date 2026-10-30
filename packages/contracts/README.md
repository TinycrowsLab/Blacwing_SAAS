# @blackwing/contracts

Zod schemas shared by api, web, worker, agent-runtime and cli (CONTEXT_PACK §5). This package depends on nothing
internal.

## Entity contracts

The core domain entities of §7, as stored records (camelCase fields; ids are the UUIDv7 `uuid` column values;
instants are `Z`-suffixed millisecond ISO-8601 strings):

| Schema                        | Entity                    | Rules the schema enforces                                                                                                                          |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantSchema`, `userSchema`  | `tenants`, `users`        | slug and region format, e-mail                                                                                                                     |
| `assetSchema`                 | `assets`                  | at least one identifier, a verified asset records its verification method                                                                          |
| `standingAuthorisationSchema` | `standing_authorisations` | never `destructive` (§8.3), approver ≠ requester (§8.4), `expiresAt` > `validFrom`, an active SA is approved and signed, a revoked SA has a reason |
| `runSchema`                   | `runs`                    | the §3.3 states, `pauseReason` exactly when paused, `endedAt` only for terminal states                                                             |
| `testCaseSchema`              | `test_cases`              | an oracle is always declared, a destructive test case never runs, blocked/skipped statuses carry a reason                                          |
| `findingSchema`               | `findings`                | §3.4 statuses, released findings record the release, `accepted_risk` carries reason and expiry                                                     |

Objects are strict (unknown keys are rejected) and every entity checks `updatedAt >= createdAt`.

These are the baseline shapes. The owning epics extend them: tenants and users in #94, assets in #354, the SA
and its scope rules in #373 and #566, runs in #564 (state machine #225), test cases in #427, findings in #739. The API maps ids to prefixed
public ids (`@blackwing/ids`) at its boundary. `@blackwing/testing` factories produce valid instances of every
schema.

## Scope rules (SCOPE-002)

`src/scope.ts` is the only definition of the scope-rule model (§7 `scope_rules`, §8.2). The SA entity's
`scopeRules` uses it (`standingScopeRulesSchema` adds "at least one `include`"). The matcher is
`matchScope(target, rules)` in `@blackwing/domain`; the Go egress matcher (EGRESS-004) mirrors it.

- `ScopeRules = { rules: ScopeRule[] }`, each rule `{ effect: 'include' | 'exclude', host?, cidr?, ports?, paths?, methods? }`.
  Every dimension a rule sets must match; an `include` must set `host` or `cidr`.
- `parseScopeRules(input)` canonicalises and throws `ScopeRuleError('SCOPE_INVALID_RULE')` on malformed rules
  (port 0, out of range or non-numeric; bad CIDR or host bits set; mid-label wildcards; `..` in a rule path; unknown fields).
- Default-deny. The most specific matching rule wins, compared as `[address, cidrPrefix, path, port, method]`:
  exact host > wildcard host > cidr (longer prefix wins); exact path > glob; single ports > range; methods listed > none.
  On a tie `exclude` wins, then the earlier rule.
- `*.example.com` matches exactly one label: not `example.com` (the apex needs its own rule), not `a.b.example.com`.
- Hosts are lowercased and IDNA-normalised (unicode and punycode match the same rule). IPv4 is held as
  IPv4-mapped IPv6, so `::ffff:10.0.0.1` and `10.0.0.1` are one address; IPv6 accepts compressed and expanded forms.
- Paths are percent-decoded exactly once, then dot segments are resolved (clamped at the root), so `..` cannot
  widen scope; double encoding is never decoded twice.
- Missing target fields are conservative: an `include` constraining a missing port/path/method does not
  match; an `exclude` constraining one still does. Host rules never match IP-only targets, and cidr rules never
  match hostname-only targets.

`src/scope.vectors.json` (export `@blackwing/contracts/scope.vectors.json`) holds the labelled
`{ rules, target, expect }` vectors and the `invalidRules` list. Both the TS tests and the Go parity tests run it;
change semantics only by changing the vectors first.

## Intrusiveness classes (SCOPE-003)

`src/intrusiveness.ts` is the only definition of the §3.5 taxonomy and its order. Import it; never
re-declare the classes or their ranks.

| Export | Behaviour |
|---|---|
| `IntrusivenessClass`, `INTRUSIVENESS_CLASSES` | `passive` < `active_safe` < `state_changing` < `destructive` |
| `INTRUSIVENESS_ORDER` | `{ passive: 0, active_safe: 1, state_changing: 2, destructive: 3 }` |
| `intrusivenessClassSchema` | Strict, case-sensitive Zod enum; unknown input fails with `SCOPE_INVALID_CLASS` |
| `parseIntrusivenessClass(v)` | Parses untrusted input, throws `IntrusivenessError('SCOPE_INVALID_CLASS')` |
| `isSelectable(c)` / `SELECTABLE_INTRUSIVENESS_CLASSES` | `false` only for `destructive`, which the UI/API never offer (§8.3) |
| `assertWithinCeiling(requested, ceiling)` | `SCOPE_DESTRUCTIVE_FORBIDDEN` for a `destructive` ceiling; `SCOPE_INTRUSIVENESS_EXCEEDS_CEILING` when `requested` ranks above `ceiling`; `SCOPE_INVALID_CLASS` for a non-canonical value (fails closed) |
| `isWithinCeiling` | Non-throwing form of the above |
| `requiresReversalJournal(c)` | `true` iff `state_changing` |
| `INTRUSIVENESS_DESCRIPTORS` | Label, meaning, generic examples and v1 status per class, for UI/help text |

The error codes are registered in `@blackwing/errors`. `contracts` is the root of the dependency
graph and cannot import that package, so `IntrusivenessError` is a plain `Error` carrying the registered
`code`; API callers wrap it with `new AppError(err.code, …)` to answer with problem+json.

## Request budgets (SCOPE-004)

`src/budget.ts` is the only definition of the budget model (§2 F5, §7). `testCaseBudgetSchema` and
`runBudgetsSchema` in the entity contracts are aliases of it. Enforcement is out of scope here: the egress
gateway enforces test-case budgets (EGRESS-010), the model gateway and cost tracker enforce cost caps
(GATEWAY-011).

| Export | Behaviour |
|---|---|
| `requestBudgetSchema` / `RequestBudget` | `{ maxRequests, maxRps, maxConcurrency, maxBytes }`: positive, finite, integers except `maxRps` (sub-1 RPS such as `0.5` is allowed); `maxRps <= maxRequests`, `maxConcurrency <= maxRequests`, `maxConcurrency <= max(1, maxRps * 60)` |
| `runBudgetSchema` / `RunBudget` | `{ costCapUsd, maxRequests, maxDurationMs }`, all positive and finite |
| `BUDGET_CEILINGS` | Absolute sanity ceilings (above them a budget is rejected as absurd; also rejects unsafe integers) |
| `DEFAULT_REQUEST_BUDGETS`, `defaultBudgetForClass(c, defaults?)` | Shipped per-class constants (below); `destructive` throws `SCOPE_DESTRUCTIVE_FORBIDDEN` |
| `parseBudgetDefaultsEnv(raw)`, `resolveBudgetDefaults(override)` | Applies the `SCOPE_BUDGET_DEFAULTS` JSON override; missing dimensions are filled from the class default |
| `validateBudget`, `validateRequestBudget`, `validateRunBudget` | Throw `BudgetError('SCOPE_INVALID_BUDGET')` for 0, negatives, NaN, Infinity, unsafe integers and absurd ceilings |
| `assertWithinSaDefaults(requested, saDefaults)` / `isWithinSaDefaults` | `SCOPE_BUDGET_EXCEEDS_SA` when any dimension the SA bounds is exceeded |
| `resolveTestCaseBudget(sa, request, testCase)` | Per-dimension minimum (most restrictive wins), clamped down to stay self-consistent; monotone |
| `checkTestCaseBudgetsAgainstRun(budgets, run)` | Flags test-case budgets whose sum (or any one) exceeds the run's `maxRequests` |

Shipped defaults:

| Class | `maxRequests` | `maxRps` | `maxConcurrency` | `maxBytes` |
|---|---|---|---|---|
| `passive` | 200 | 5 | 2 | 50 MiB |
| `active_safe` | 2000 | 20 | 5 | 200 MiB |
| `state_changing` | 500 | 5 | 2 | 100 MiB |

Units: RPS is requests per second; bytes are request + response bytes as counted by the egress gateway;
cost is USD priced from the price-table version pinned on the run (§8.9). This model carries the cap, never
the price. A run's `maxRequests` bounds the sum of its test-case budgets; a single request or test-case
budget above the run total is flagged at submit, and strict enforcement is EGRESS/GATEWAY.

## Audit event contract (AUDIT-001)

`src/audit/` defines the one shape every audit producer emits (CONTEXT_PACK §8.8). Persistence and the hash
chain are AUDIT-002; emission is AUDIT-003.

| Export                                                            | What it is                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AuditEventSchema`                                                | Validates an event: strict shape, NFC normalisation of every string, the 16 KB metadata cap, the severity floor and I-JSON well-formedness. A missing `tenantId` or an unknown `action` is invalid (fail closed).                                      |
| `AUDIT_ACTION_CATALOGUE`, `auditActionSchema`, `auditActionEntry` | The action catalogue: `{ action, defaultSeverity, isAlwaysAudited, actionClass?, description }` per action, grouped by domain. It covers every §8.8 class (login, approval, gate decision, tool action, finding release, export, kill, config change). |
| `canonicalJson`                                                   | JCS (RFC 8785) canonical JSON.                                                                                                                                                                                                                         |
| `auditEventHashInput`                                             | The text whose SHA-256 is `hash`: JCS over every field except `hash`, with absent optionals omitted.                                                                                                                                                   |
| `auditEventJsonSchema`                                            | The same shape as JSON Schema draft 2020-12.                                                                                                                                                                                                           |

Rules producers must follow:

- **`metadata` is redacted by the producer** before the event is built (§8.7). The ledger is append-only, so a
  secret written into it can never be removed. Record references (secret ref ids, evidence keys), never values.
  The only PII an event carries is the actor's e-mail (lawful audit basis).
- Canonical `metadata` is at most 16 KB (UTF-8). Larger payloads go to the evidence store, and the event
  carries `metadataRef` (`evidenceKey`, `sha256`, `sizeBytes`) plus a small summary. `measureAuditMetadata`
  tells a producer which case applies. A `__proto__` key is rejected because JavaScript would silently drop it
  from the hashed value.
- Strings are NFC-normalised before hashing. Lone surrogates, non-finite numbers and non-JSON values are
  rejected.
- `severity` may be raised above the catalogue default for one event, never lowered.
- `occurredAt` is producer wall time and only informational. Ordering is `seq` and the hash chain.
- **The catalogue is additive-only.** Append new actions (and target types) at the end. Never rename, remove or
  reorder an entry, because stored events and the Go gateway refer to them by name. A test pins the released
  list.

Two committed artifacts serve the Go egress gateway, which does not run TypeScript:

- `schemas/audit-event.schema.json`: the JSON Schema (`@blackwing/contracts/schemas/audit-event.schema.json`).
  NFC, the size cap and the severity floor cannot be expressed in JSON Schema, so Go producers apply them in code.
- `test-vectors/audit-event-hash.json`: inputs with their expected canonical text and SHA-256, for checking
  another implementation's canonicalisation (AUDIT-005 and the gateway).

Tests check that both files match what the code generates. After an intended contract change, delete the file
and run `pnpm --filter @blackwing/contracts test` to regenerate it, then review the diff.

## Surface graph contracts (GRAPH-001)

`src/surface.ts` is the only definition of the surface-graph node and edge shapes (CONTEXT_PACK §3.1). The
repository, upsert, planner and INGEST code import it. The module is pure, with no graph-driver imports.

- Node kinds: `asset`, `host`, `service`, `technology`, `endpoint`, `parameter`, `role`. Every node carries
  `tenantId` and a `provenance` record (`confidence` in 0..1, ordered `firstSeenAt`/`lastSeenAt`).
- Edge kinds: `RESOLVES_TO`, `EXPOSES`, `RUNS`, `SERVES`, `HAS_PARAM`, `CAN_ACCESS` (with `expected: 'allow' | 'deny'`).
  Each edge joins a `fromKey` and a `toKey` of the allowed kinds, both in the edge's own tenant (§8.6).
- `naturalKey(node)` is the GRAPH-002 MERGE key, in the form `kind:tenantId:...`. Free-text components that can
  hold a `:` are percent-encoded where needed, so distinct nodes never share a key.
- Hostnames are stored as canonical A-labels (`café.example` and `xn--caf-dma.example` are one host). IP literals,
  wildcards and invalid names are rejected. The IP is canonicalised.
- A service banner longer than `SURFACE_BANNER_MAX` is truncated with an ellipsis, never rejected.
- Endpoint `pathTemplate` is canonical, with no query, fragment or dot segments. `baseUrl` must be http(s) with no
  credentials, query or fragment.
- A parameter stores `name`, `location` and `dataType` only. Its `example`/`value` keys are rejected (§8.7).
- `templatise(path)` turns a concrete path into a template, replacing numeric, UUID and long hex segments with `{id}`.
- `SURFACE_CONTRACT_VERSION` is a semver. Bump the major on any breaking change to a schema or to `naturalKey`.
  The contract snapshot test in `surface.test.ts` lists the fields, so a change shows up in review.
- Objects are strict. Unknown keys are rejected, and `null` is rejected for an optional field: absent means unknown.

## Oracle catalogue (F14)

`src/oracles.ts` holds the declared oracle **specs** that a test case binds to before it runs (`ORACLE_CATALOGUE_VERSION`).
Execution is out of scope and belongs to the VALIDATE epic.

- `OracleSpecSchema` is a discriminated union on `type`: `marker`, `status_diff`, `error_signature` and `header_cookie_flag`.
  Every spec carries `description`, `readOnly: true` and an `intrusiveness` hint (`passive` or `active_safe`, never `destructive`).
- `params` objects are strict. No field accepts a body, command or other payload string. Header values are restricted to a printable charset.
- `parseOracleSpec(json)` throws `OracleSpecError` with a stable code: `ORACLE_TYPE_UNKNOWN`, `ORACLE_SPEC_INVALID` or
  `ORACLE_SPEC_TOO_LARGE` (over `ORACLE_SPEC_MAX_BYTES`, 8 KiB). `isOracleSpec(value)` is the type guard.
- `ORACLE_REGISTRY` maps each type to a label and standards IDs.
