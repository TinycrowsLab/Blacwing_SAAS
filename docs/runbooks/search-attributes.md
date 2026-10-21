# Temporal search attributes

Custom search attributes that make run workflows listable and filterable in Temporal visibility (WORKFLOW-003,
CONTEXT_PACK §3.3, §8.5). Run state stays authoritative in Postgres. These attributes are a read-side index only.

| Attribute  | Type    | Set by                                                         |
| ---------- | ------- | -------------------------------------------------------------- |
| `tenantId` | Keyword | `runStartSearchAttributes` when a run workflow starts          |
| `runId`    | Keyword | `runStartSearchAttributes` when a run workflow starts          |
| `runState` | Keyword | `upsertRunSearchAttributes(state)` from workflow code on every state change |

`SEARCH_ATTRIBUTES` in `apps/worker/src/search-attributes.ts` is the single definition. Attributes are never
dropped or retyped. Values are non-secret identifiers and run states only. No PII goes into an attribute.

## Registration

Registration is idempotent. Run it on every deploy and whenever the dev stack starts.

- **Dev stack:** `pnpm dev:deps` runs the `temporal-bootstrap` job (`infra/compose/temporal/bootstrap.sh`). It creates
  the namespace and registers the attributes with the `temporal` CLI. Re-running it changes nothing that exists.
- **Deploy and any environment:** `pnpm --filter @blackwing/worker register:search-attributes`. It reads
  `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and the TLS settings through `@blackwing/config`. It exits 0 when the
  attributes are present, whether created now or already there. It exits 1 on any failure.

Results are logged, and each call records one `search_attribute_registration_total{result}` sample with
`result` set to `created`, `unchanged`, `conflict` or `failed`.

### Type conflict (`SEARCH_ATTR_TYPE_CONFLICT`)

An attribute already registered with a different type (for example `tenantId` as `Int`) stops registration. Nothing
is created, dropped or retyped, in either the script or the compose bootstrap. The error names the attribute and both
types. To resolve it:

1. Confirm which attribute is wrong: `temporal operator search-attribute list --namespace <ns>`.
2. A custom attribute cannot be retyped in place. Coordinate with the owners of the workflows that write it, then
   decide on a new name or a migration. Do not delete it on your own.

### Concurrent registration (multi-pod deploy)

Two pods can register at the same time. Registration lists, adds the missing attributes, and on any add failure lists
again. If every attribute now exists with the right type, the add failure was a harmless race and the result is
`unchanged`. If an attribute is still missing, the original add error is raised. This is idempotent without a
separate lock. Registration never removes an attribute.

## Visibility limitation

Custom search attributes need an advanced visibility store (Elasticsearch, or advanced SQL visibility as in the dev
auto-setup image). On a standard-visibility server the add fails and the script exits 1. Run list queries on
standard visibility are not possible for custom attributes. In that case, list runs from the Postgres `runs` table
instead of Temporal visibility. Run state is always in Postgres, so nothing is lost.

## Querying

```text
tenantId = "t-acme" and runState = "executing"
```

Visibility is eventually consistent: a state change may take a moment to appear. Keep an assertion in an integration
test with a retry window, as `apps/worker/src/search-attributes.int.test.ts` does.

## Verification

- `pnpm --filter @blackwing/worker test` covers the planning, registration, conflict and race logic against a fake
  operator service, and the state validation.
- `pnpm --filter @blackwing/worker test:int` needs the dev stack. It registers the attributes twice, runs a probe
  workflow and finds it by `tenantId` and `runState`, and checks that a conflicting attribute fails with
  `SEARCH_ATTR_TYPE_CONFLICT` without changing anything.
- `scripts/temporal-bootstrap.test.mjs` covers the compose bootstrap, including its type-conflict path.
