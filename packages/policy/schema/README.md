# Blackwing Cedar schema

`blackwing.cedarschema` is the single authorisation contract shared by every Cedar policy, the
TypeScript engine (`@cedar-policy/cedar-wasm`, pinned in the pnpm catalog), the Go egress gateway
(`github.com/cedar-policy/cedar-go`, pinned in `apps/egress-gateway/go.mod`) and the parity test
vectors (POLICY-001, CONTEXT_PACK §3.1 / §5).

## Model

| Kind | Cedar names |
|---|---|
| Principals | `Blackwing::AgentSession`, `Blackwing::User`, `Blackwing::ServiceAccount` |
| Resources | `Blackwing::Target`, `Blackwing::TestCase`, `Blackwing::Run`, `Blackwing::Asset` |
| Enum | `Blackwing::IntrusivenessClass` = `passive`, `active_safe`, `state_changing`, `destructive` (SCOPE-003 order) |
| Actions | `Egress::Action::"httpRequest"`, `"tcpConnect"`, `"dnsResolve"`; `Tool::Action::"invoke"`; `Scope::Action::"requestException"`; `Policy::Action::"edit"`; `Gate::Action::"decide"` |
| Context | `Blackwing::DecisionContext` `{ nowUtc, envelope { saId, validFrom, expiresAt, maxIntrusiveness, scopeHash }, intrusiveness, reversalJournalPresent, windowOpen, tenantId }`; `ToolInvokeContext` adds `toolName`; `GateDecideContext` adds `gate`, `requestedBy` |

Cedar has no subtyping, so "principal" and "resource" are groups of separate entity types; each
action's `appliesTo` lists the ones it accepts. Every entity also carries `tenantId` so the
baseline can require principal, resource and context to agree (§8.6).

Intrusiveness is a record `{ level: IntrusivenessClass, rank: Long }`. `level` names the class and
`rank` is its position in the SCOPE-003 order, so the baseline compares ceilings with
`context.intrusiveness.rank <= context.envelope.maxIntrusiveness.rank`. Build values only with
`intrusivenessValue()` from `@blackwing/policy`, which derives the rank from the class.

## What Cedar does not do

Scope matching (host globs, CIDR ranges, ports, paths) never happens in Cedar. The caller runs the
SCOPE-002 matcher in code and passes the result as `Target.inScope`. `Target.ip` is plain text, so a
policy cannot call `ip(...).isInRange(...)` on it (validation rejects it). This keeps one
deterministic, tested implementation of scope and prevents a class of policy mistakes.

## Failure semantics

All context attributes are required. A request with a missing or ill-typed attribute fails schema
request validation; without request validation the policy hits an evaluation error and its
`permit` does not apply. The engine (POLICY-006) must map every error, failure or unknown to
**deny** (fail closed, §8.2 / §8.11). Policy validation is strict and also rejects validator
warnings, such as a policy that can never apply.

## Versioning

`SCHEMA_VERSION` (semver) and `SCHEMA_SHA256` live in `src/schema.ts` and the version is repeated
in the schema file's header. Policy snapshots (POLICY-007) record `schemaPin()` and every run pins
it (§8.9). A test fails when the schema bytes change without a new digest, and the generated TS
types (`src/schema.types.ts`) are checked for drift.

- **Minor bump**: adding an entity type, an optional attribute, an action or a context attribute
  that callers already supply.
- **Major bump**: removing or renaming anything, changing a type, or adding a required attribute
  that existing callers do not send. A major bump needs a snapshot/version migration: runs pinned
  to the old version keep evaluating against their pinned snapshot, and new snapshots are written
  against the new version.

After editing the schema: bump `SCHEMA_VERSION` (here and in the header), update `SCHEMA_SHA256`,
run `pnpm --filter @blackwing/policy gen:schema-types`, and run the policy and egress-gateway tests.
