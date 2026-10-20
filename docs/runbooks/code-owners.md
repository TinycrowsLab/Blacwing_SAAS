# Code owners

[`.github/CODEOWNERS`](../../.github/CODEOWNERS) routes review of each path to an owning team. Security-owned paths
get a mandatory security review, which supports the governance in
[CONTEXT_PACK §4](../architecture/CONTEXT_PACK.md#4-claude-code-as-the-agent-runtime-critical-design) and
[§8](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).
Review is only enforced once branch protection turns on "Require review from Code Owners" (CI-015, #153).

## Owner registry

Every owner named in CODEOWNERS must be listed here. `scripts/check-github.mjs` fails otherwise.

| Owner | Status | Responsibility |
|---|---|---|
| `@TinycrowsLab/blackwing-maintainers` | placeholder | Default owner of every path not listed below. |
| `@TinycrowsLab/blackwing-security-owners` | placeholder | Security review of the security-owned paths below. Its members know the §8 invariants. |

**Placeholder** means the team does not exist in the `TinycrowsLab` organisation yet. GitHub reports such owners as
unknown and cannot request reviews from them, so a placeholder must never be combined with required code-owner
review. A required review that nobody can give would block every merge on that path. #842 creates the teams
(online porting). Until then:

- do not enable "Require review from Code Owners" on `main`;
- ask a repository admin to review changes to security-owned paths by hand.

## Security-owned paths

| Path | Why (CONTEXT_PACK §8) |
|---|---|
| `apps/egress-gateway/**` | The only route to targets: scope and budgets are enforced there, and it fails closed (§8.1, §8.2). |
| `packages/policy/**` | Cedar policy decision point and the shared schema (§8.1, §8.3, §8.4, §8.11). |
| `packages/crypto/**` | Envelope signing and verification, key handling (§8.1, §8.7). |
| `packages/secrets/**` | Secrets service and envelope encryption (§8.7). |
| `packages/audit/**` | Append-only, tamper-evident audit ledger (§8.8). |
| `/.github/CODEOWNERS`, `/.github/workflows/**` | The review rules themselves and the CI that gates merges. |
| `/SECURITY.md`, `/.gitleaks.toml`, `/.trivyignore` | Disclosure policy and the secret- and vulnerability-scanner configuration. |

## Activating a team

1. An organisation owner creates the team, adds at least two members and gives the team **write** access to the
   repository. GitHub ignores code owners without write access.
2. Check that GitHub reports no CODEOWNERS errors:
   `gh api repos/TinycrowsLab/Blacwing_SAAS/codeowners/errors` must return `{"errors":[]}`.
3. Set the team's status in the registry above to `active`. Once both teams are active, remove the `OFFLINE-STUB`
   marker from CODEOWNERS.
4. Only then may branch protection require code-owner review (#153).

## Changing CODEOWNERS

- The **last** matching line wins. Keep the default `*` rule first and the more specific rules after it.
- GitHub does not support `!` negation, `[ ]` character ranges or `\#` escapes in CODEOWNERS. The test rejects them.
- A new owner needs a row in the registry above. A new security-owned path needs a row in the table above and the
  `security` label on the issue that adds it.
- Changes to CODEOWNERS are themselves reviewed by the security owners.
