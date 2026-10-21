# Contributing to the documentation

The docs under `docs/` are built into a static site by `pnpm docs:build` (DOCS-001, #813). The build fails on a
broken internal link, and CI runs the same check (`pnpm docs:check`) on every pull request that touches `docs/**`.
Merges to `main` publish the `main` version of the site.

## Where a page goes

| Folder | What belongs there |
|---|---|
| `user/` | Guides for people who use the product. |
| `runbooks/` | Step-by-step operating procedures. Operator-facing pages also appear in the Admin Guide section. |
| `api/` | API reference material. The generated OpenAPI files are committed here. |
| `architecture/` | Design documents, including the Context Pack. |
| `adr/` | Architecture decision records, following [`adr/template.md`](adr/template.md). |

A new page must be added to a section in [`site.json`](site.json). The build fails when a page is missing from the
navigation, and when a navigation entry names a file that does not exist.

## Style

- **One H1 per page**, at the top. Use H2 and H3 for sections. Heading anchors are generated from the heading text, so
  keep headings unique within a page.
- **Short sentences in the imperative** for procedures. Put one action in each numbered step.
- **Callouts** use a blockquote that starts with the kind in bold, or with a GitHub-style alert marker:

  > **Warning**: the kill switch stops every running assessment. Confirm the scope before you use it.

  Kinds: `Note`, `Tip`, `Important`, `Warning`, `Caution`.
- **Language:** English only in v1. Do not add translations or mixed-language pages.
- **Code and commands** go in fenced blocks with a language tag. Use inline code for file names, env keys and IDs.

## Links

- Link to another page with a relative path, for example `../runbooks/release.md`. Use the `.md` name; the build
  rewrites it to the page's HTML address.
- Link to a file elsewhere in the repository with a relative path (for example `../../CLAUDE.md`) or a root-relative
  path (`/CLAUDE.md`). The build links it to the repository on GitHub.
- Anchors must match a heading on the target page. The link check reports a missing heading as a broken link.
- External links are not fetched in CI. `pnpm docs:check --external` fetches them and reports failures as warnings only.

## Images and screenshots

- Keep images below about 1600 px wide, and optimise PNGs before you commit them. The site lazy-loads images.
- Give every image alt text that describes what the reader needs to see.

## Security and privacy checklist (CONTEXT_PACK §8.7)

Before you open a documentation pull request, confirm that the page and its screenshots contain none of:

- [ ] secrets, tokens, passwords, API keys, private keys or connection strings;
- [ ] internal hostnames, private IP addresses, AWS account IDs or internal ARNs;
- [ ] real customer names, asset addresses or finding data;
- [ ] the product described as "Claude Code" (it is "Blackwing", optionally "Powered by Claude").

Screenshots must be taken from the demo tenant, and any window that shows an address bar or a terminal prompt must be
cropped or redacted first.

## Versions

Each release publishes its own version of the site (for example `v1.4.0/`), so a customer can read the documentation
that matches their version. Unreleased changes appear under `main/`. The version list is `versions.json` at the root of
the published site.

## Check locally

```sh
pnpm docs:check            # navigation and internal links
pnpm docs:build --out dist/docs --version main
```

Open `dist/docs/main/index.html` in a browser to review the rendered site.
