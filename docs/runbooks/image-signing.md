# Image signing and provenance (CI-010)

The `sign` job in `.github/workflows/build-images.yml` signs every published image digest with cosign
keyless signing (GitHub OIDC to Fulcio, logged to Rekor) and attaches two attestations: the CycloneDX SBOM
from the `sbom` job and a SLSA v1 build provenance predicate. Signatures and attestations live in GHCR next
to the image. There are no long-lived keys.

## Rules

- Signs by digest from `images.json`, never by tag.
- Runs only online (`vars.BW_ONLINE == 'true'`), on pushes to `main` or `v*` tags, never on pull requests
  or forks. `id-token: write` is granted to this job only.
- A Fulcio or Rekor outage fails the job, so the publish is not complete: do not ship unsigned images.
  Retry with "Re-run failed jobs" once Sigstore is healthy. Each run records the Rekor log index per image in
  the step summary.

## Expected identity (shared with CI-011)

`infra/docker/signing-identity.json` is the single source of truth for the issuer, repository, workflow path
and trusted refs. `node scripts/signing.mjs identity` derives the certificate-identity regexp from it and
fails if the workflow file no longer exists (identity drift). Deploy-time verification (CI-011) must read the
same file; see [image-verification.md](image-verification.md) for the deploy-time gate.

```sh
cosign verify \
  --certificate-identity-regexp "$(node scripts/signing.mjs identity | sed -n 's/^identity-regexp=//p')" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/tinycrowslab/bw-api@sha256:<digest>
```

Use `cosign verify-attestation --type cyclonedx` or `--type slsaprovenance1` for the attestations.
