# Platform baseline policy set (POLICY-002)

The `.cedar` files in this directory are the platform's **non-overridable** floor (CONTEXT_PACK §7,
§8). Every tenant inherits them and no tenant policy can weaken them. They are platform-operator
artifacts: tenants can read but never modify them, and the console (ADMIN-004) shows them with a
"baseline, non-overridable" notice.

## Why a tenant can never override the baseline

`compilePolicySet()` in `src/baseline.ts` puts every baseline policy into the policy set **before**
the tenant policies, keyed by its reserved `baseline.*` id. Every baseline policy is a `forbid`, and
in Cedar a matching `forbid` always beats any number of matching `permit`s. A tenant can therefore
only narrow what the baseline allows (add its own `forbid`s or omit `permit`s), never widen it.
The golden tests include the attempted overrides (a tenant `permit` written for exactly the
destructive request still yields deny) and a property test over arbitrary tenant permits.

`compilePolicySet()` rejects the whole tenant set when a tenant uses a `baseline.` id or `@id`
annotation, when an entry is not exactly one static policy, or when strict schema validation fails
(unknown action, entity type or attribute, so a tenant cannot redefine the model, POLICY-001).

## Policies

| File / ids | Invariant | Feature | Rule |
|---|---|---|---|
| `destructive.cedar` (`.egress`, `.tool`, `.scope-exception`) | §8.3 | F4 | Deny anything at the `destructive` class, from the request context or the test case. |
| `state-changing.cedar` (`.egress`, `.tool`) | §8.3 | F4, F20 | `state_changing` (request or test case) needs a prior reversal-journal entry **and** an envelope whose ceiling is at least `state_changing` (it is signed only after Gate 1). |
| `intrusiveness-ceiling.cedar` (`.egress`, `.tool`) | §8.1, §8.3 | F3, F4 | Never exceed the envelope's `maxIntrusiveness` or the session's `intrusivenessCeiling`. |
| `out-of-scope.cedar` (`.egress`, `.tool`) | §8.2 | F1, F11 | Default deny: a `Target` with `inScope == false` is unreachable. |
| `private-range.cedar` (`.egress`, `.tool`) | §8.2 | F11 | Private/link-local/metadata destinations are denied unless the target is in scope **and** the SA lists that range explicitly (CWE-918). |
| `envelope-validity.cedar` (`.egress`, `.tool`) | §8.1 | F3, F13 | Deny outside `[validFrom, expiresAt)` or when the window is closed. |
| `scope-hash.cedar` (`.egress`, `.tool`) | §8.1, §8.9 | F37 | The envelope's `scopeHash` must equal the run's `pinnedScopeHash`. |
| `sod-gate-decide.cedar` | §8.4 | F31, F13 | A user never decides a gate request they raised. |
| `sod-scope-exception.cedar` | §8.4 | F31, F13 | A scope exception's approver is never its requester. |
| `tenant-isolation.cedar` | §8.6 | F32 | Principal, resource and context must belong to the same tenant. |

Cedar's strict validator does not accept one `action in [...]` list spanning several action
namespaces, so a rule that covers egress and tool invocation is written as one policy per namespace
in the same file (`baseline.<file>.egress`, `baseline.<file>.tool`).

## Decisions and boundaries

- **Expiry boundary.** Validity is half-open: allowed at exactly `validFrom`, denied at exactly
  `expiresAt` and after.
- **Facts computed in code.** Scope (`Target.inScope`), private/metadata detection
  (`isPrivateRange`, `isMetadata`) and "the SA names this range" (`saIncludesRange`) are computed
  by the SCOPE-002 matcher and the gateway, never in Cedar (schema README).
- **Missing context fails closed.** Every context attribute is required by the schema. The engine
  (POLICY-006) must evaluate with schema request validation on and map every failure or error to
  deny. Without request validation Cedar skips a `forbid` whose condition errors, which is why that
  validation is mandatory (tested).

## Versioning

`BASELINE_VERSION` (semver) and `BASELINE_SHA256` live in `src/baseline.ts`. The digest covers
every file's name and exact bytes in file-name order, comments included. Snapshots (POLICY-007)
record `compilePolicySet().pin`, which carries the baseline and schema pins, and every run pins it
(§8.9). A test fails when a file changes without a new digest. Adding a `forbid` is a minor bump;
changing or removing one is a major bump that needs security review. Baseline changes are
platform-operator actions, audited by operator tooling and signed with the snapshot (POLICY-007).
