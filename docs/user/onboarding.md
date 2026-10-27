# Developer onboarding and troubleshooting

DEVENV-015 (#169). The human-facing guide from a bare host to a running dev stack and a `pnpm test:e2e` run. It
links to the detailed runbooks instead of copying them. The Claude-Code-facing index is
[CLAUDE.md](../../CLAUDE.md); the rules every change must follow are in the
[Context Pack](../architecture/CONTEXT_PACK.md) (stack [§5](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage),
invariants [§8](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch),
workflow [§10](../architecture/CONTEXT_PACK.md#10-development-environment--workflow)).

Blackwing is an authorised, human-gated security testing platform. Everything here runs on your machine against
deliberately vulnerable training targets, never against anything you do not own.

## Prerequisites

| Need | Detail |
|---|---|
| Host | Ubuntu 24.04 LTS (AWS EC2 dev instance, laptop or VM). 8 vCPU / 16 GB RAM is the practical minimum; 8 vCPU / 32 GB / 200 GB is recommended. |
| Access | A user with `sudo` rights for the one-time bootstrap. |
| Network | Internet access to pull packages, npm modules and container images. |
| Tools | Installed for you by `infra/bootstrap.sh`: Docker Engine + compose, gVisor `runsc`, Node 22, pnpm, Go, OpenTofu, kubectl, helm, mkcert, jq. Versions are pinned in [`infra/versions.env`](../../infra/versions.env). |

Other operating systems:

- **macOS:** the bootstrap supports Ubuntu only. Install Docker Desktop, Node 22, pnpm (`corepack enable`) and
  mkcert yourself at the pinned versions, then continue from step 2. There is no gVisor on macOS: use the Docker
  driver with `runc` (allowed in `BW_ENV=dev` only) and `BW_K3S_SKIP=1`.
- **Linux, hostnames:** `*.localhost` resolves to loopback on most distributions. If it does not, run
  `infra/compose/tls/setup-tls.sh --print-hosts` and append the printed line to `/etc/hosts`.
- **Linux, Docker group:** after the bootstrap adds you to the `docker` group, run `newgrp docker` or log out and in.
- **WSL2:** works for everything except real gVisor; see [dev-k3s.md](../runbooks/dev-k3s.md#k3d-substitute-hosts-without-gvisor-eg-wsl2).

## Quick start

```bash
# 1. One-time host setup (Ubuntu 24.04). Idempotent; --dry-run shows what would change.
infra/bootstrap.sh
newgrp docker                 # only if the script says the docker group is not active yet
infra/bootstrap.sh --check    # expected-versus-actual table; must exit 0

# 2. Dependencies and environment
pnpm install
cp .env.example .env          # optional: pnpm dev:deps creates it and fills random dev passwords itself
pnpm dev:deps                 # postgres, valkey, neo4j, temporal, keycloak, openbao, minio, mailpit, ...
pnpm db:migrate               # the seed never creates tables
pnpm db:seed                  # demo tenant "acme", test users, Juice Shop asset, standing authorisation

# 3. Targets, apps, tests
pnpm targets:up               # OWASP Juice Shop on http://127.0.0.1:13000 (the default target)
pnpm dev                      # runs dev:doctor first, then every app with hot reload
pnpm test:e2e                 # Playwright suites against the stack and Juice Shop
```

Notes:

- `pnpm dev:deps` creates `.env` from `.env.example` when it is missing, generates a random value for every empty
  `*_PASSWORD`, `*_SECRET` and `*_TOKEN`, and never overwrites an existing value. `*_CLIENT_SECRET` values (for
  example the Google SSO client) are issued externally and filled by hand.
- Run `pnpm dev:doctor` at any time. It lists missing `.env` keys, the health of every service and the endpoints.
  It prints key names and URLs, never values.
- `pnpm test:e2e` runs the Playwright suite in `apps/web/e2e` (CI-006, #140) against the stack and Juice Shop
  (`pnpm targets:up`); see [`docs/runbooks/e2e.md`](../runbooks/e2e.md). Unit tests are `pnpm test`;
  integration tests (`pnpm test:int`) use Testcontainers on random ports and need no running stack.
- Optional pieces: `pnpm dev:tls` (HTTPS on `*.bw.localhost`), `pnpm dev:deps:obs` (Grafana stack),
  `pnpm targets:up --all` (every training target), the k3s/gVisor sandbox runtime ([dev-k3s.md](../runbooks/dev-k3s.md)).

### Minimal path for constrained laptops

Skip everything optional. Run `pnpm dev:deps`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm targets:up` (Juice Shop
only), `pnpm dev`. Do not start `dev:deps:obs`, `dev:tls` or the other targets. Set `BW_K3S_SKIP=1` so
`infra/k3s/install-dev.sh` exits 0 and sandboxes use the Docker driver with `runsc` instead of k3s.

## Dev endpoints

All ports bind `127.0.0.1` only. Ports come from `.env` (defaults in [`.env.example`](../../.env.example)); the
compose file is [`infra/compose/docker-compose.dev.yml`](../../infra/compose/docker-compose.dev.yml).

| Service | URL | Notes |
|---|---|---|
| Console (web) | `http://localhost:3000` | Next.js dev server. Over HTTPS (after `pnpm dev:tls`): `https://app.bw.localhost:18443` |
| API | `http://localhost:13400` | Over HTTPS: `https://api.bw.localhost:18443` |
| Keycloak | `http://localhost:18080` | Realm `blackwing-dev`. Admin console user `BW_DEV_KEYCLOAK_ADMIN_USER`. Over HTTPS: `https://auth.bw.localhost:18443` |
| Temporal UI | `http://localhost:18233` | Namespace `blackwing-dev`; gRPC on `localhost:17233` |
| MinIO console | `http://localhost:19001` | S3 API on `http://localhost:19000`; root user `BW_DEV_MINIO_ROOT_USER` |
| Mailpit | `http://localhost:18025` | SMTP on `localhost:11025` |
| OpenBao | `http://localhost:18200` | Token in `.bw-dev/openbao/app-token` |
| Grafana (`obs` profile) | `http://localhost:13001` | User `admin`; also Prometheus `19090`, Loki `13100`, Tempo `13200` |
| Postgres / Valkey / Neo4j | `15432` / `16379` / `17474` (bolt `17687`) | Credentials in `.env` |
| Juice Shop (target) | `http://localhost:13000` | `https://juice.bw.localhost:18443` with `pnpm targets:up --tls` |

Other targets (`pnpm targets:up --all`): crAPI 13010, VAmPI 13020, DVGA 13030, DVWA 13040, WebGoat 13050.

### Dev login users

Realm `blackwing-dev` ([`realm-export.json`](../../infra/compose/keycloak/realm-export.json), the single source).
Every user shares the password in `BW_DEV_KEYCLOAK_TEST_USER_PASSWORD` in your `.env`. `pnpm db:seed` creates the
matching application users in tenant `acme`.

| User | Role |
|---|---|
| `appsec@acme.test` | AppSec engineer |
| `owner@acme.test` | Asset owner |
| `dev@acme.test` | Developer |
| `admin@acme.test` | Org admin |
| `auditor@acme.test` | Auditor |
| `operator@blackwing.test` | Platform operator (not a member of `acme`) |

`pnpm dev:keycloak:check` verifies the realm export against the running Keycloak. The table above is cross-checked
against the realm export, `.env.example` and the compose file by `pnpm check:onboarding` (see
[Keeping this guide honest](#keeping-this-guide-honest)).

## Dev-only shortcuts: never in staging or production

- **Password login** for the test users above, and the shared test-user password. Staging and production use SSO
  only (Keycloak brokering to the customer IdP).
- **The mkcert dev CA** behind `*.bw.localhost`. Never install or ship its root certificate anywhere else.
- **`runc` sandboxes** (`BW_ENV=dev|test` only) and the **k3d** `gvisor` RuntimeClass mapped to `runc`.
- **OpenBao in dev mode**, the MinIO root user, and every generated value in `.env`.
- **The seed** refuses `NODE_ENV=staging|production`. Do not work around that.

`.env` is untracked, mode `0600`, and never contains real customer secrets. Never paste a secret into an issue,
commit, log or test fixture (§8.7).

## Troubleshooting

Start with `pnpm dev:doctor`. It names the unhealthy service and the fix. For service logs:
`docker compose -p bwdev --env-file .env -f infra/compose/docker-compose.dev.yml logs -f <service>`.

| Symptom | Cause and remedy |
|---|---|
| Docker or `runsc` not ready: `Cannot connect to the Docker daemon`, `permission denied` on the socket, `unknown runtime specified runsc` | Daemon down: `sudo systemctl start docker`. Group not active: `newgrp docker`, or log out and in. Runtime missing: `infra/bootstrap.sh --check`, then `infra/bootstrap.sh`. Verify `docker run --rm --runtime=runsc --network=none hello-world`. WSL2 and old kernels cannot run gVisor: see [dev-host-bootstrap.md](../runbooks/dev-host-bootstrap.md#failure-modes). |
| Node version mismatch: `Unsupported engine` or the `preinstall` script aborts | Node must be `>=22 <23` and pnpm `>=9 <10`. Run `node -v`, then `corepack enable && corepack prepare --activate` (the version is pinned by `packageManager`), or rerun `infra/bootstrap.sh`. |
| Ports in use: `port is already allocated`, `address already in use` | Find the owner: `ss -ltnp \| grep :<port>`. Stop your own process, or change the `BW_DEV_*_PORT` value in `.env` and rerun `pnpm dev:deps`. Never stop containers you did not start. |
| A service is unhealthy or `pnpm dev:deps` times out | `pnpm dev:doctor`, then the service log (command above). Retry `pnpm dev:deps`; it is idempotent and only waits for what is not healthy. Low memory is the usual cause: close other stacks or use the minimal path. |
| Missing `.env` key: `check-env` or `dev:doctor` lists empty keys, compose says `required variable ... is missing` | `pnpm dev:deps` adds missing keys and fills empty passwords. Fill `*_CLIENT_SECRET` by hand if you use it. Compare with `pnpm check-env`. |
| Keycloak `Invalid parameter: redirect_uri` | The console must run on an origin registered for client `bw-console-bff`: `http://localhost:3000`, `https://app.bw.localhost` or `https://app.bw.localhost:18443`. Do not use `127.0.0.1:3000`. Verify with `pnpm dev:keycloak:check`; restore the realm with `pnpm dev:keycloak:reset`. |
| Login fails for a seeded user | The password is `BW_DEV_KEYCLOAK_TEST_USER_PASSWORD` from `.env`. If you changed it after the first start, run `pnpm dev:keycloak:reset`. |
| Stale volumes or a half-initialised stack (bootstrap loops, wrong passwords after editing `.env`) | `pnpm dev:deps:reset --yes` drops the shared `bwdev` stack and its volumes and recreates it. Then `pnpm db:migrate && pnpm db:seed`. It affects every worktree that uses the stack. |
| `temporal` or `keycloak` unhealthy with `password authentication failed` in a second checkout or worktree | Every checkout shares the one `bwdev` stack and its volumes, but `pnpm dev:deps` generates new passwords for a fresh `.env`. Copy `.env` from the checkout that first created the stack (`cp ../<first-checkout>/.env .env`), then rerun `pnpm dev:deps`. Use `pnpm dev:deps:reset --yes` only if nobody else is using the stack. |
| `pnpm db:seed` logs `seed.skipped` for some steps | Migrations for those tables are not applied. The log line names the missing table. Run `pnpm db:migrate`, then `pnpm db:seed`. See [dev-seed.md](../runbooks/dev-seed.md#safety-notes). `pnpm db:seed:reset` re-creates the seeded rows. |
| Browser warns about the certificate, or Node says `unable to verify the first certificate` | The mkcert CA is not trusted. Rerun `pnpm dev:tls` (it runs `mkcert -install`). Firefox and Java keep their own stores: restart them. For Node clients: `export NODE_EXTRA_CA_CERTS=infra/compose/tls/certs/rootCA.pem`. |
| `app.bw.localhost` does not resolve | Run `infra/compose/tls/setup-tls.sh --print-hosts` and add the line to `/etc/hosts`. |
| k3s or gVisor problems: pods stuck `ContainerCreating`, `RuntimeClass gvisor not found`, `verify.sh` failures | Run `infra/k3s/verify.sh` and read [dev-k3s.md](../runbooks/dev-k3s.md). Hosts without gVisor: `infra/k3s/install-dev.sh --k3d` (the gVisor checks report NOT VERIFIED). Constrained laptops: `BW_K3S_SKIP=1`. |
| Juice Shop is not reachable on 13000 | `pnpm targets:smoke`, then `pnpm targets:reset juice-shop`. DVWA needs its one-time setup page after the first start. |
| Observability stack missing in Grafana | It is opt-in: `pnpm dev:deps:obs`, then `pnpm dev:deps:obs:smoke`. |

## Contribution workflow

The rules are [CONTEXT_PACK §10](../architecture/CONTEXT_PACK.md#10-development-environment--workflow); CLAUDE.md
summarises them for agents.

1. **Branch per issue**, named `<key>-<slug>`, for example `egress-004-request-budgets`.
2. **Conventional Commits** (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`). Valid scopes: `pnpm commit:scopes`.
   The commit hook enforces the format.
3. **Pull request** titled like the commit, with `Closes #N` and the issue's acceptance-criteria checklist copied
   into the PR template and ticked as you prove each item.
4. **Definition of Done** (all must hold before review):
   - All acceptance criteria met and tested (unit plus integration where IO is involved; e2e for user-visible flows).
   - Every edge case in the issue has an explicit test.
   - Lint, typecheck and tests green in CI; no `any`, no skipped tests, no TODO without a linked issue.
   - Tenant isolation, authz and audit events covered wherever data or actions are touched.
   - OpenAPI/GraphQL schema, Zod contracts, migrations and docs updated in the same PR.
   - Structured logs, metrics and traces for new paths; no secrets in logs.
   - Security invariants (§8) preserved, with threat considerations noted in the PR.

Before you push: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`.

## Walkthrough record

2026-10-20, WSL2 dev host (not a bare Ubuntu host): `pnpm install`, `pnpm dev:doctor` (reports the stopped stack and
names the fix) and `pnpm dev:deps` (creates `.env`) behave as described. Starting a second worktree against
existing `bwdev` volumes failed with the Temporal password error now listed under troubleshooting. The full
bare-Ubuntu run to `pnpm test:e2e` (bootstrap needs `sudo`) is still a manual check; record it here when it is done.

## Keeping this guide honest

`pnpm check:onboarding` (run by `pnpm test:scripts` in CI) fails when:

- a relative link or `#anchor` in `docs/user/*.md` does not resolve;
- a `pnpm <script>` command shown here is not a script in the root `package.json`;
- a login user, Keycloak redirect origin, or port in the tables disagrees with
  `infra/compose/keycloak/realm-export.json` or `.env.example`.

When you change the stack, update the single source first (compose file, `.env.example` or the realm export),
then this guide. Related: [dev-host-bootstrap.md](../runbooks/dev-host-bootstrap.md),
[dev-seed.md](../runbooks/dev-seed.md), [dev-k3s.md](../runbooks/dev-k3s.md),
[compose README](../../infra/compose/README.md), DEVENV-010 (#164), DEVENV-011 (#165), DEVENV-012 (#166),
DEVENV-013 (#167), DEVENV-014 (#168).
