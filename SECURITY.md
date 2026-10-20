# Security policy

Blackwing is a security product; we take vulnerabilities in it seriously.

## Reporting a vulnerability

- **Do not** open a public GitHub issue, discussion or pull request for a suspected vulnerability.
- Report it privately through GitHub's **"Report a vulnerability"** button on the repository's
  **Security** tab (private vulnerability reporting / security advisories).
- Include the affected component (app/package path), version or commit, reproduction steps,
  impact, and any proof-of-concept. Never include real customer data or live credentials.

## Scope

In scope: everything in this repository (`apps/`, `packages/`, `infra/`, CI workflows) and
the security invariants in [`docs/architecture/CONTEXT_PACK.md`](docs/architecture/CONTEXT_PACK.md) §8
(e.g. egress fail-closed, tenant isolation, secret handling, append-only audit, kill switch).

Out of scope: third-party vulnerable targets used for evaluation (`eval/targets`, e.g. OWASP
Juice Shop) — they are intentionally vulnerable.

## Handling secrets

Secrets, keys and certificates are never committed (`.env`, `*.pem`, `*.key` are ignored).
If you find a committed secret, report it as above so it can be revoked and rotated.

> Placeholder policy created with the repository skeleton (FOUND-001); the full
> disclosure process and contacts are finalised before launch.
