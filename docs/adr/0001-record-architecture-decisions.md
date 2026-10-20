# ADR-0001: Record architecture decisions as numbered, immutable ADRs

Date: 2026-10-20

## Status

Accepted

## Context

The Context Pack fixes the v1 stack, layout, domain model and security invariants, and its issue-writing standard
demands decisive choices ("pick one, per this pack"). The pack records *what* was decided, but its tables give
little room for *why*, and a fixed decision without a written rationale gets re-litigated in every issue. The
repository layout already reserves `docs/adr/` for decision records.

## Decision

We record every architecture decision as an Architecture Decision Record in `docs/adr/`, using a lightweight
MADR-based format ([`template.md`](template.md)):

- **File name:** `NNNN-kebab-case-title.md`, numbered from `0001` without gaps or reuse.
- **Title:** `# ADR-NNNN: <decision in the imperative>`, followed by a `Date: YYYY-MM-DD` line.
- **Sections, in order:** `Status`, `Context`, `Decision`, `Consequences`, `References`.
- **Status values:** `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or `Superseded by [ADR-NNNN](…)`.
- **Citations:** every ADR cites the Context Pack section it derives from with a heading link, and every `§N`
  it mentions must exist in the pack. ADRs restate the pack; when they disagree, the pack wins and the ADR is
  corrected or superseded.
- **Scope:** an ADR restates the decision and its rationale, not implementation detail (file contents, versions,
  option lists), so it does not go stale as the code moves.
- **Index:** [`README.md`](README.md) lists every ADR with its title and status.

ADRs are **immutable once accepted**. To reverse or change a decision we write a new ADR whose Status section
says `Supersedes [ADR-NNNN](…)`, and we change the old ADR's status line, and nothing else, to
`Superseded by [ADR-MMMM](…)`. Both directions must be present. A decision that changes the Context Pack is made
in the same change that edits the pack.

`pnpm check:adr` (`scripts/check-adr.mjs`) enforces the format, the citations, the supersession links, the
index and a Markdown lint, and its self-tests run in `pnpm test`.

## Consequences

- Reviewers can point at a numbered decision instead of re-arguing it; a challenge to it takes the form of a new
  ADR, which keeps the history readable.
- Per-epic decisions are added later as new ADRs by the epics that own them; the initial set (0001 to 0011) only
  restates decisions the Context Pack already made and introduces none.
- A renamed or removed Context Pack heading breaks `pnpm check:adr`, so ADR citations cannot silently drift from
  the pack.

## References

- [Context Pack §6 Repository layout](../architecture/CONTEXT_PACK.md#6-repository-layout-create-exactly-this):
  `docs/adr/` is part of the fixed layout.
- [Context Pack §11 Issue-writing standard](../architecture/CONTEXT_PACK.md#11-issue-writing-standard-for-generators):
  "Be concrete and decisive. Never contradict §5 or §8."
- [Context Pack §10 Definition of Done](../architecture/CONTEXT_PACK.md#definition-of-done-applies-to-every-issue):
  docs are updated in the same change.
- FOUND-015 (#17) created this record set.
