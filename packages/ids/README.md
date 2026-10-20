# @blackwing/ids

UUIDv7 generation and prefixed public ids (CONTEXT_PACK §5: "IDs are UUIDv7 stored as `uuid`, plus
human-friendly prefixed public IDs where shown"). Every package that creates an identifier uses this one.

```ts
import { FindingId, newId, newPublicId, parsePublicId, RunId, toPublicId, toUuid } from "@blackwing/ids";

const id = newId();                     // "0192f0c4-6a3e-7b1d-8c2f-5e9a0d4b7c11" (Uuid): the DB `uuid` value
const runId = toPublicId(id, "run");    // "run_01jbr…" (RunId): what the API and UI show
toUuid(runId) === id;                   // true: 1:1 with the uuid column

RunId.parse(input);                     // validates a public id from a request; returns RunId or throws
FindingId.parse(runId);                 // throws IdValidationError (reason "prefix_mismatch")
RunId.fromUuid(row.id);                 // DB row -> branded public id
parsePublicId(input);                   // { prefix, uuid, id }, narrowed by prefix
```

## UUIDv7

`newId()` returns a canonical lowercase UUIDv7 (RFC 9562 §5.7): a 48-bit Unix millisecond timestamp,
a 42-bit counter (12 bits of `rand_a` + 30 of `rand_b`) and 32 random bits from `node:crypto`.

- **Monotonic within a process** (RFC 9562 §6.2, method 1). A new millisecond reseeds the counter with
  41 random bits. The same millisecond increments it. If the clock goes backwards, the generator keeps
  the last timestamp and keeps incrementing, so ids never decrease or repeat. On counter overflow the
  timestamp moves forward by 1 ms. Sequential ids keep B-tree inserts local.
- "Process" means one JS realm. Each worker thread has its own generator. Ids from different
  processes are unique (random seeds and tails) but not ordered relative to each other.
- **Allocation-light.** Random bytes come from a 4096-byte pool refilled in one `randomFillSync` call.
  The returned string is the only allocation per id.
- `createUuidV7Generator({ now, randomFill, poolSize })` builds an independent generator for tests.

## Public ids

Format: `<prefix>_<body>`. The body is the UUID's 16 bytes in **lowercase Crockford base32** with no
padding: 26 characters, alphabet `0123456789abcdefghjkmnpqrstvwxyz`. The value is read as a 130-bit
number with two leading zero bits (the ULID convention), so the first character is `0`–`7`, and public
ids sort in creation order like their UUIDs.

Parsing is strict, so every id has exactly one textual form:

| Input | Reason |
|---|---|
| not a string | `not_a_string` |
| no `_`, empty prefix/body, prefix not lowercase `a-z` | `malformed` |
| prefix not in the registry | `unknown_prefix` |
| registered prefix, but not the one asked for | `prefix_mismatch` |
| body not 26 characters | `invalid_length` |
| uppercase, mixed case, `i`/`l`/`o`/`u`, padding, any other character | `invalid_base32` |
| first body character above `7` (more than 128 bits) | `non_canonical` |
| decodes to something other than a version-7, RFC-variant UUID | `not_uuidv7` |

Errors are `IdValidationError`, a subclass of `ValidationError` from `@blackwing/errors`
(`name: "ValidationError"`, `code: "VALIDATION_FAILED"`, HTTP 422, `retryable: false`, plus a
machine-readable `reason`), so `toProblemDetails` maps them to a 422 problem+json body with the
message as `detail`. Messages never echo the rejected input.

## Prefix registry

| Prefix | Type | Entity (§7) |
|---|---|---|
| `run` | `RunId` | runs |
| `fnd` | `FindingId` | findings |
| `asset` | `AssetId` | assets |
| `sa` | `StandingAuthorisationId` | standing_authorisations |
| `tp` | `TestPlanId` | test_plans |
| `tc` | `TestCaseId` | test_cases |
| `sub` | `SubtaskId` | subtasks |
| `sess` | `SessionId` | agent_sessions |
| `evd` | `EvidenceId` | evidence_items |
| `tok` | `ApiTokenId` | api_tokens (the row id, never the `bw_pat_`/`bw_ci_` secret) |
| `ten` | `TenantId` | tenants |
| `usr` | `UserId` | users |
| `oob` | `OobId` | oob_correlations |
| `kill` | `KillEventId` | kill_events |

Each type is `string & { readonly __brand: "<Type>" }`, so passing a `FindingId` where a `RunId` is
expected is a compile error, and so is passing a plain string or a bare `Uuid`. Each type has a
same-named constructor (`RunId.parse/is/fromUuid/toUuid/generate`). `ID_TYPES[prefix]` gives the
constructor for a prefix chosen at runtime. To add an entity, extend `ID_PREFIXES` and `entities.ts`.
Never rename or reuse a prefix once ids carrying it have been issued: public ids live on in audit
events (§8.8), tickets and reports.

## Security notes

- Public ids are opaque. They hold only the UUID: no tenant data and no PII.
- A UUIDv7 reveals its creation time to the millisecond, and ids from one process are sequential.
  Ids are **references, not secrets or capabilities**. Authorisation never depends on an id being hard
  to guess. Every lookup is tenant-scoped (RLS, §8.6) and permission-checked.
- At an API boundary, validate ids with the constructors (`RunId.parse`) or `isPublicId`. A Zod schema
  in `@blackwing/contracts` can wrap them (`z.string().refine(RunId.is)`).
