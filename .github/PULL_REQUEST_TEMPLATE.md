<!--
One issue = one PR (CLAUDE.md, CONTEXT_PACK §10). Title: a Conventional Commit, e.g.
`feat(egress-gateway): enforce per-test-case request budgets`.
Never paste secrets, tokens, customer data or exploit payloads into this description.
-->

## Summary

<!-- What changed and why, in 2-4 sentences. Name the apps/packages touched. -->

## Linked issue

Closes #

<!-- The issue key and number, e.g. `EGRESS-004`, `Closes #193`. One issue per PR. -->

## Acceptance criteria

<!--
Copy the "Acceptance criteria" checklist from the linked issue verbatim, then tick each item
and say how it is proven (test name, command or observable behaviour).
-->

- [ ] <!-- criterion copied from the issue --> (proof: )

## Definition of Done

<!-- CONTEXT_PACK §10. Tick every item; explain any item that does not apply. -->

- [ ] All acceptance criteria met and demonstrably tested (unit + integration where IO is involved; e2e for user-visible flows).
- [ ] Edge cases listed in the issue have explicit tests.
- [ ] Lint/typecheck/tests green in CI; no `any`, no skipped tests, no TODOs without a linked issue.
- [ ] Tenant isolation, authz and audit events covered where the change touches data or actions.
- [ ] OpenAPI/GraphQL schema, Zod contracts, migrations and docs updated in the same PR.
- [ ] Observability: structured logs, metrics and traces for new paths; no secrets in logs.
- [ ] Security invariants (§8) preserved; threat considerations noted in the PR.

## Security considerations

<!--
CONTEXT_PACK §8. Name every invariant this change touches and how it stays enforced (with the
test that proves it), or write "None touched" with a one-line reason. Note new threats,
authz rules, audit events emitted and redaction. Offline substitutes carry
`OFFLINE-STUB(online-porting #N)` and link their porting issue.
-->

- Invariants touched (§8.1-§8.11):
- Threats considered and mitigations:
- Audit events emitted:
- Secrets / redaction:

## Test evidence

<!-- Commands run and their result, plus test names for each acceptance criterion and edge case. -->

```text
pnpm lint
pnpm typecheck
pnpm test
```
