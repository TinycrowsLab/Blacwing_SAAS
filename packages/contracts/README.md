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
