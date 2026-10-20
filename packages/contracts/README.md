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
