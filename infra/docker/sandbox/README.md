# bw-sandbox base image (IMAGE-001, #599; pentest tools IMAGE-002, #600)

Multi-stage, non-root base for the per-run sandbox. Later IMAGE issues populate `/opt/bw/*`.

- Build (repo root as context): `docker build -f infra/docker/sandbox/Dockerfile -t bw-sandbox:dev .`
- Offline build: `--build-arg PNPM_INSTALL_FLAGS=--offline` with a pre-populated pnpm store; the lockfile is always frozen.
  The tools stage downloads release archives, so it needs network unless you build with a cached layer.
- Production images are amd64. The tools stage fails on other architectures because `tools.pin.json` pins linux/amd64
  release assets only (arm64 dev builds need arm64 pins first).
- The base image is pinned by digest (`NODE_IMAGE` arg, also the `org.opencontainers.image.base.name` label).

## Pinned ProjectDiscovery tools (IMAGE-002, #600)

`tools.pin.json` is the single source of truth for `subfinder`, `dnsx`, `httpx`, `naabu`, `katana` and `nuclei`:
exact version, immutable release-asset URL, sha256 and licence (MIT). The `tools` stage runs `install-tools.sh`,
which downloads each archive over HTTPS, verifies its sha256 **before** extracting, extracts only the named binary
into `/opt/bw/tools/bin`, and checks that `<tool> -version` reports the pinned version. Any mismatch fails the build.
The binaries are root-owned and read-only for `bw`, and nothing fetches tool updates at runtime. Templates
(IMAGE-004) and the manifest (IMAGE-008) are separate issues.

Bump a tool by changing its entry (version, URL and sha256 together) in a reviewed change; Renovate (IMAGE-011) opens
those bumps. Licences: see `docs/architecture/third-party-notices.md`.

## Pinned pentest scanners (IMAGE-002, #601)

`scanners.pin.json` pins `ffuf`, `fingerprintx`, `testssl.sh`, `gitleaks`, `opengrep`, `trivy`, `sqlmap` and `jq`
(name, exact version, SPDX licence, source, download URL and sha256 per architecture; Go modules by their `h1:` zip
hash). The `tools` stage runs `tools/install-tools.mjs`, which fetches each artifact, fails the build on any digest
mismatch or failing version probe, and installs into `/opt/bw/tools` (`bin/` on PATH, `lib/` off PATH, `manifest.json`
lists what shipped). The runtime stage copies that tree root-owned, so uid 10001 cannot replace a tool. The
ProjectDiscovery tools stay in `tools.pin.json` (#600) so their installer and guard are unchanged.

- Licence posture: `testssl.sh` (GPL-2.0), `sqlmap` (GPL-2.0) and `opengrep` (LGPL-2.1) run as separate processes, never
  linked into Blackwing code.
- `sqlmap` is reached only through `bw-sqlmap` (`tools/bw-sqlmap.mjs`), which allow-lists safe options, forces batch
  mode and rate limits, and refuses destructive or out-of-band options. The raw tool is not on PATH.
- nmap and Semgrep are excluded by design. The image test asserts they are absent.
- Static guard: `node scripts/check-sandbox-tools.mjs` (run by `pnpm check:sandbox-image`).
- Unit tests: `node --test scripts/check-sandbox-tools.test.mjs scripts/install-tools.test.mjs scripts/bw-sqlmap.test.mjs`.

Runtime contract (SANDBOX): user `bw` uid/gid 10001, read-only rootfs, `/workspace` and `/tmp` as tmpfs owned by
10001, all capabilities dropped. The entrypoint exits 78 with a clear message if `/workspace` is not writable and 77 if run as root.

Checks: `pnpm check:sandbox-image` (static: Dockerfile, dockerignore, both tool pins), `pnpm test:sandbox-image`
(builds and runs the image; also proves the checksum guard refuses a mismatched archive).

## Vendored nuclei-templates (IMAGE-004, #602)

The `templates` entry in `tools.pin.json` pins `projectdiscovery/nuclei-templates` to one commit (SHA, version, archive
sha256 and a kept-tree digest). The `tools` stage runs `tools/install-templates.mjs`, which downloads the commit's archive
over HTTPS, verifies its sha256 before unpacking, keeps only the `keep` directories (`dns`, `helpers`, `http`, `network`,
`ssl`), deletes the `exclude` paths (the non-safe `http/` categories) and checks the kept tree against `treeSha256`. Any
mismatch fails the build and nothing is written to `/opt/bw/templates/official`. The installed tree records its pin in
`.bw-template-pin.json`; the run manifest (IMAGE-008) surfaces the same commit.

- The runtime stage copies `/opt/bw/templates` root-owned and read-only for `bw`, so a run cannot write templates.
- `templates/nuclei.yaml` is the default profile, installed at `/etc/bw/nuclei.yaml` and passed with `-config`. It selects
  `info` and `low` severities and the safe tags only, excludes the intrusive tags, disables out-of-band callbacks and
  turns off template updates (`update-templates: false`, `disable-update-check: true`).
- `templates/blackwing/README.md` is the authoring convention for Blackwing's own templates (`/opt/bw/templates/blackwing`).
- Static guard: `scripts/check-sandbox-templates.mjs`, run by `pnpm check:sandbox-image`. Unit tests:
  `node --test scripts/check-sandbox-templates.test.mjs scripts/install-templates.test.mjs`.

## Headless browser and fonts (IMAGE-005, #603)

The image bakes in the Chromium build that the pinned `playwright-core` downloads, into the root-owned
`/opt/bw/browsers` (`PLAYWRIGHT_BROWSERS_PATH`). `install-browser.sh` runs in the runtime stage at build time only. It
checks the installed `playwright-core` and `@playwright/mcp` against `tools.pin.json`, installs the pinned Debian font
packages (Noto Latin, CJK and colour emoji, plus Liberation), installs Chromium only with `playwright install --with-deps
chromium`, and smoke-launches it headless as `bw`, checking the Chromium version against the pin. Nothing downloads at
runtime, so a launch works with `--network none`.

- Versions: `tools.pin.json` `browser` (Playwright, `@playwright/mcp`, Chromium version and revision) and `fonts`. The
  Playwright pair must equal the `pnpm-workspace.yaml` catalog; `check-sandbox-image` fails otherwise.
- Launch flags: Playwright's default `--no-sandbox` for Chromium. The container is the isolation boundary (runsc, the
  read-only rootfs, all capabilities dropped and SANDBOX-007), so Chromium's own namespace sandbox is not relied on.
- Headful mode is not supported in the sandbox. Only headless Chromium is installed.
- Build smoke and offline launch are covered by `pnpm test:sandbox-image`.

## Bundled wordlists (IMAGE-006, #604)

`wordlists.pin.json` pins the wordlists baked into `/opt/bw/wordlists` for `ffuf` and `katana` discovery: content paths,
parameter names and subdomain prefixes, vendored under `wordlists/<category>/` from SecLists (MIT) at one upstream commit.
Each entry records `{name, category, version, licence, source, sha256}`, and each licence text is listed and checked too.

- The `tools` stage runs `tools/install-wordlists.mjs`. It checks every list against its sha256, requires an allowlisted
  licence (MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC0-1.0) with its licence text, requires valid UTF-8, and enforces the
  total against `IMAGE_WORDLISTS_MAX_MIB` (default 64). Bytes are copied verbatim, and `manifest.json` is written. The
  runtime stage copies the tree root-owned, so `bw` cannot edit the lists.
- Trimming an oversized list to its top-N entries is a reviewed change to the vendored file and its pin. It never happens
  at build time.
- Static guard: `node scripts/check-sandbox-wordlists.mjs`, run by `pnpm check:sandbox-image`. It also fails on any file
  under `wordlists/` that no pin entry lists. Unit tests: `node --test scripts/install-wordlists.test.mjs`.
- Tenant-supplied lists are out of scope. The convention for a later mounted input is `/opt/bw/wordlists/tenant/<name>.txt`,
  read-only, outside the pinned tree.

## Seccomp profile (SANDBOX-007)

`seccomp/bw-sandbox.json` is the default-deny seccomp profile every sandbox runs under. It allows only the
syscalls Node 22 and the toolchain need, refuses `clone3` with ENOSYS so glibc falls back to filtered `clone`,
and never allows ptrace, mount, bpf, namespace joins or io_uring. The sandbox controller's spec builder
(`apps/sandbox-controller/src/spec/hardening.ts`) references it: Kubernetes as `Localhost` `bw-sandbox.json`,
Docker as `seccomp=/etc/bw/seccomp/bw-sandbox.json`.

Distribution to nodes (the profile is never unconfined; a missing file makes create fail):

- Kubernetes: copy the file to `/var/lib/kubelet/seccomp/bw-sandbox.json` on every worker node (the kubelet
  seccomp root), by the node bootstrap in `infra/k3s`. The `Localhost` profile must exist before a sandbox pod
  is scheduled, or kubelet refuses to start it.
- Docker (dev and on-prem): install to `/etc/bw/seccomp/bw-sandbox.json` on the Docker host. The Docker driver
  must check the file exists before `createContainer` and fail closed otherwise.

The toolchain-under-profile check (running the real tools) is owned by SANDBOX-013.
