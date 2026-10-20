# @blackwing/contracts

Zod schemas shared by api, web, worker, agent-runtime and cli (CONTEXT_PACK §5). This package depends on nothing
internal.

## Entity contracts

The core domain entities of §7, as stored records (camelCase fields; ids are the UUIDv7 `uuid` column values;
instants are `Z`-suffixed millisecond ISO-8601 strings):

| Schema | Entity | Rules the schema enforces |
|---|---|---|
| `tenantSchema`, `userSchema` | `tenants`, `users` | slug and region format, e-mail |
| `assetSchema` | `assets` | at least one identifier, a verified asset records its verification method |
| `standingAuthorisationSchema` | `standing_authorisations` | never `destructive` (§8.3), approver ≠ requester (§8.4), `expiresAt` > `validFrom`, an active SA is approved and signed, a revoked SA has a reason |
| `runSchema` | `runs` | the §3.3 states, `pauseReason` exactly when paused, `endedAt` only for terminal states |
| `testCaseSchema` | `test_cases` | an oracle is always declared, a destructive test case never runs, blocked/skipped statuses carry a reason |
| `findingSchema` | `findings` | §3.4 statuses, released findings record the release, `accepted_risk` carries reason and expiry |

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
