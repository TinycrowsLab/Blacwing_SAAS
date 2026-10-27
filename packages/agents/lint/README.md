# Prompt lint

`pnpm lint:prompts` checks every persona prompt under `packages/agents/prompts/` and the base preamble
(`_base`). CI runs it in the `lint` job of the `pr` workflow on every pull request and every push to `main`.
A finding fails the job and is annotated on the pull request at its file and line.

The linter lives in `packages/agents/src/prompt-lint.ts` (rules) and `packages/agents/src/prompt-lint-cli.ts`
(collector and CLI). The reviewed denylist and allowlist are in [`denylist.json`](./denylist.json).

## Rules

| Rule | Fails when |
|---|---|
| `front-matter` | The file has no valid front-matter, its persona is not its directory, its version is not its file name, the file name is not `<semver>.md`, or the directory is not a known persona. A new persona prompt without front-matter fails here. |
| `base-preamble` | A persona does not compose with the `_base` preamble, or the composed prompt does not begin with the filled preamble. |
| `placeholder` | A persona body contains `{name}` (persona bodies are not filled at run time), the preamble names a placeholder that is not part of the contract, or the preamble lacks one. |
| `standard-id` | An identifier-shaped token is malformed. Formats: `WSTG-<CATEGORY>[-NN]`, `CWE-<number>`, `A01` to `A10`, `API01` to `API10`, `ASVS v5.0.0` or `ASVS v5.0.0-V<chapter>[.<section>[.<item>]]`. A bare name such as `ASVS` or `CWE` is prose and is not checked. |
| `forbidden-content` | A line matches a rule in `denylist.json` (payload-shaped text: injection strings, traversal sequences, shell chains, raw request lines and similar). Each denylist rule is its own rule id, for example `sqli-union-select`. |
| `allowlist` | An allowlist entry no longer matches anything. Remove it. |

Findings print as GitHub workflow errors: `::error file=<path>,line=<n>,title=prompt-lint <rule>::<message>`.
A forbidden-content finding never prints the matched text, so the CI log does not carry the payload.

## Denylist

`denylist.json` holds two lists.

- `rules[]`: `id` (kebab-case), `description`, `pattern` (a JavaScript regular expression, tested per line) and
  `flags` (a subset of `imsu`, default `i`). A pattern must be valid and must not match the empty string.
  Validation runs when the file is parsed, so a broken rule fails the lint.
- `allowlist[]`: `rule`, `file` (repo-relative path), `token` (the exact matched text) and `reason`. An entry
  excuses one token in one file for one rule. Each entry needs a written reason and must still match, or the
  lint reports it as unused.

The denylist errs toward flagging. A rule matches payload shapes and never matches prose about payloads, so the
preamble may say "do not author exploit payloads" without a finding. Do not add working payloads or attack
tooling to the list or to any fixture.

### Adding a rule

1. Write the pattern for the payload shape, not for a topic word.
2. Add a fixture to `packages/agents/src/prompt-lint.test.ts` that the rule flags, using a minimal, benign shape.
3. Run `pnpm --filter @blackwing/agents test` and `pnpm lint:prompts`. The real prompts must still pass.

### Allowing a false positive

Add an allowlist entry for the exact token and file, with a reason a reviewer can check. Prefer rewording the
prompt when the wording itself is ambiguous. Never allowlist a token that is a real payload.

### Tracked violations in released prompts

A released prompt is hash-locked in `prompts.lock.json`, and only the release process changes that lock. When a
released prompt already cites a malformed identifier, the fix is a new prompt version. Until that ships, an
allowlist entry records the exception. Its reason must name the follow-up, and the entry must be removed with
that fix.

## Changing prompts

Prompt content, composition and the release gate belong to other issues (REGISTRY-002, -004 and -008). This lint
only checks structure, forbidden content, identifiers and placeholders. It does not judge persona behaviour.
