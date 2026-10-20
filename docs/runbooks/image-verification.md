# Image verification before deploy (CI-011)

No image reaches an environment unless it is provably built and signed by this repository. Two layers enforce
this:

1. **Deploy-time gate.** `.github/workflows/verify-images.yml` is a reusable workflow (`workflow_call` only).
   Deploy workflows (CI-017, CI-018) call it with the `images.json` artifact name and make every rollout job
   `needs: verify-images`. A failed or skipped verification means no rollout.
2. **Admission-time policy.** `infra/k3s/policy/verify-images.yaml` is a sigstore policy-controller
   `ClusterImagePolicy` in `enforce` mode for `ghcr.io/tinycrowslab/bw-*`. INFRA installs the controller and
   applies the manifest. Label every Blackwing namespace `policy.sigstore.dev/include=true`.

## What is checked

For each `service -> ref@sha256:…` in `images.json` (tags are rejected), `scripts/verify-images.mjs` runs:

- `cosign verify` with the certificate identity regexp and OIDC issuer from
  `infra/docker/signing-identity.json`. This is the same file the CI-010 sign job uses, so the two cannot drift.
  The regexp pins the exact repository, the `build-images.yml` workflow and the trusted refs (`main`, `v*` tags).
- `cosign verify-attestation --type cyclonedx` (SBOM) and `--type slsaprovenance1` (SLSA v1 provenance). A
  signature without both attestations fails.

The script then re-checks cosign's output. Every signature must name the deployed digest, the exact issuer and
a subject that matches the pinned identity. At least one signature must have a Rekor log entry. Each attestation
must be an in-toto statement of the expected predicate type whose subject is that digest.

## Fail closed

Every one of these aborts the deploy: unsigned image, foreign identity or issuer, missing or mismatched
attestation, Rekor, Fulcio or TUF lookup error, registry error, cosign timeout (`VERIFY_TIMEOUT_MS`, default
120 s) and a missing cosign binary. The gate never passes `--insecure-ignore-tlog`, `--insecure-ignore-sct` or
the insecure registry flags. When Sigstore is down, wait and re-run. Do not deploy around the gate.

## Observability

The step summary lists each verified digest with its certificate identity and Rekor log index links, or the
reasons each digest failed. Failures are also emitted as `::error::` annotations.

## Local check

```sh
node scripts/verify-images.mjs --images images.json --services api,web
node --test scripts/verify-images.test.mjs   # offline: uses a fake cosign
```

## Air-gapped or offline verification (later)

Verification needs Rekor and the Sigstore TUF root, which are online. If a disconnected environment is ever
needed, do not weaken the gate. Instead:

- At build time, save each signature and attestation bundle (`cosign save` or `cosign download` with
  `--bundle`) next to the image digest.
- Mirror the Sigstore trusted root (`cosign initialize --mirror … --root …`) into the environment, or pass a
  pinned `--trusted-root` file.
- Run `cosign verify --offline --bundle …` with the same identity and issuer, and keep the Rekor inclusion
  proof check. That variant is tracked with the online porting work (#874). The current gate stays online-only.
