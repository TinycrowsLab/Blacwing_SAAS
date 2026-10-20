# Pull-request checks

The `pr` workflow (`.github/workflows/pr.yml`, CI-002 #136) runs on every pull request and every push to `main`.
Its three jobs are the required status checks that branch protection references (CI-019). Their names are
fixed: `pnpm check:actions` fails if a job is renamed, dropped or given a matrix (a matrix appends its values to
the check name).

| Check | Runs | Fails when |
|---|---|---|
| `lint` | `pnpm lint` (ESLint 9, `--max-warnings=0` in every member and in `lint:root`), then `pnpm format:check` | any ESLint error or warning (for example an `any`), or a file Prettier would rewrite |
| `typecheck` | `pnpm typecheck` (`tsc -b` per member through Turborepo, cached) | any type error |
| `commitlint` | `node scripts/ci-pr.mjs commitlint` | any commit in the range is not a Conventional Commit |

## Behaviour

- **Node 22 only.** The single supported version comes from the workflow's `NODE_VERSION`, with no matrix.
- **Least privilege.** The workflow's only permission is `contents: read`, and it uses no secrets. Forked pull
  requests run every job. The setup action (`.github/actions/setup`) gives them read-only caches.
- **Superseded runs are cancelled.** There is one concurrency group per pull request (or per pushed ref), with
  `cancel-in-progress`.
- **Docs-only changes.** The `changes` job (`node scripts/ci-pr.mjs changes`) marks a change set as docs-only
  when every changed file is under `docs/`, ends in `.md` or is `LICENSE`. In that case the ESLint step and the
  `typecheck` job are skipped, and a skipped job counts as passed. Prettier still checks the docs. The skip is
  fail-closed: if the change set is unknown (a new branch, a force push, a missing commit) or the `changes` job
  fails, every check runs. The triggers have no path filters, because a filtered-out workflow would leave the
  required checks pending.
- **Commit range.** A pull request lints `base.sha..head.sha`. A push lints `before..after`, or only the tip
  commit when `before` is unknown. A local run lints `origin/main..HEAD`.
- **Annotations.** Turborepo prefixes each line with `<package>:<task>:`, and tsc prints paths relative to the
  package. `scripts/ci-annotate.mjs` rewrites each diagnostic into one line with a path relative to the
  repository. The problem matchers in `.github/actions/problem-matchers` (tsc, ESLint and Prettier) then turn
  those lines into inline annotations on the pull request. The same script appends a job summary with the
  diagnostic counts, the first 50 diagnostics and the Turborepo cache hit rate.
- **Turborepo cache.** The setup action restores `.turbo`, so re-running an unchanged commit is a full cache
  hit. The `typecheck` job summary shows it as `N/N tasks cached (full Turborepo cache hit)`.
- **Stable formatting.** `.gitattributes` forces LF line endings everywhere, so `format:check` gives the same
  result on every platform. Generated files are excluded from lint and format (`eslint.config.mjs` `IGNORES`,
  `.prettierignore`).

## Reproducing a failure locally

```sh
pnpm lint && pnpm format:check                      # lint
pnpm typecheck                                      # typecheck
node scripts/ci-pr.mjs commitlint                   # commitlint over origin/main..HEAD
pnpm typecheck 2>&1 | node scripts/ci-annotate.mjs --task typecheck   # the annotated output CI shows
```
