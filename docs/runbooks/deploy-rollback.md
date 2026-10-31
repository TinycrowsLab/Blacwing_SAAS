---
last_validated: never
---

# Deploy, upgrade and rollback runbook (INFRA, LAUNCH)

Owner: INFRA (infrastructure and cluster), with LAUNCH for the cutover. Read with
[§5 (stack: k3s, Helm, OpenTofu, Traefik, cert-manager)](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage)
and [§8.9 (pinned versions)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).
Related: [release.md](release.md), [db-migrations.md](db-migrations.md), [image-verification.md](image-verification.md),
[ingress-tls.md](ingress-tls.md).

> **Status: not yet validated, and the deploy step is not in the repo.** `last_validated: never` stays until the
> staging drill in [Validation](#validation) has run. The release, build, verify and migrate workflows exist on
> `main`. The staging deploy workflow (CI-017) is on `main`. The production deploy (CI-018) and the staging cluster rollout do not.
> Steps that need them are marked **not implemented**.

## 1. The pipeline on main

| Stage | Workflow or tool | What it does | State on main |
|---|---|---|---|
| Merge | `pr.yml` | Required checks (`lint`, `typecheck`, `commitlint`, `boundaries`) | implemented |
| Release | `release.yml` | semantic-release computes `vX.Y.Z` from Conventional Commits, tags it, creates the GitHub Release and dispatches the image build | implemented |
| Build | `build-images.yml` | Builds digest-pinned images, with SBOM, Trivy scan and signing. Writes an `images.json` artifact | implemented |
| Record | `release.yml` ("Record release") | Stores the release record: tag, commit and image digests | implemented |
| Verify | `verify-images.yml` (reusable) | Deploy-time supply-chain gate. Fails closed on any signature, attestation, registry or timeout failure | implemented, reusable only |
| Migrate | `migrate.yml` (reusable) | Forward-only database migrations, with the destructive-migration guard (`NODE_ENV=production`) | implemented, but the secret-store step is a stub (online-porting #893) and fails on purpose |
| Deploy (staging) | `deploy-staging.yml` (CI-017, #151) | Resolves the release record, runs `verify-images`, then `helm upgrade --install --atomic` of `infra/helm/blackwing` with digest-pinned values, a smoke check and a rollback on a failed smoke check | implemented; the live rollout needs the staging cluster (online-porting #915). Production (CI-018) **not implemented** |
| Infrastructure | OpenTofu under `infra/tofu/environments/{dev,staging,prod}` | AWS, k3s, storage (INFRA-006), DNS and email | IaC on main. Applying it needs the AWS account (online) |

Two rules hold regardless of stage:

- **Images are pinned by digest.** A deploy names `image@sha256:...` from the release record, never a tag. Every
  run records these digests (§8.9).
- **Verification comes before rollout.** The deploy job must `needs: verify-images`, so a failed verification
  aborts the deploy before any pod changes.

## 2. Pre-deploy checks

Run these on the target environment before any change:

1. The release record for the version exists, with the commit and all digests (from the `release-record`
   artifact of `release.yml`).
2. `verify-images` is green for those digests.
3. `tofu validate` and `tofu plan` pass for the environment (`tofu -chdir=infra/tofu/environments/<env> plan`), and the plan shows only the expected changes. Never apply a plan you have not read.
4. The migration plan is forward-only. Check the new migrations in `packages/db/migrations` against
   [db-migrations.md](db-migrations.md). A destructive migration needs an approved exception before it runs
   in production.
5. Confirm the kill switch works in the target environment before cutover (see
   [kill-switch.md](kill-switch.md), section 4). A deploy must not go ahead while the kill path is unknown.

## 3. Procedure: deploy an upgrade (once the deploy workflow exists)

1. **Infrastructure first, if the plan changed it.** `tofu plan` and `tofu apply` for the environment. Keep the
   saved plan file, and do not apply a plan from another commit.
2. **Migrations.** Run `migrate` (the reusable workflow). It is forward-only and must succeed before the new
   application version starts.
3. **Verify, then roll out.** Verification runs as a dependency of the rollout job. Helm upgrades each release
   to the pinned digests from the release record.
4. **Watch the rollout.** Check that pods are ready and that `up` is 1 for every scrape target on the starter
   dashboard (`bw-overview`). Confirm there are no new `bw_tenant_context_missing_total` increments (a missing
   tenant context fails closed, so a rise means a bug in the deploy).
5. **Confirm the kill path and audit trail.** Confirm `bw_audit_chain_head` is still advancing for the tenant
   set you are watching.
6. Record the deploy in the release record: the environment, time, operator and digests.

Helm releases are named by the chart. The charts in the repo are `infra/helm/blackwing` (the application, release
`blackwing`, namespace `bw-system`), `infra/helm/bw-ingress` and `infra/helm/bw-keycloak-realm`. Do not invent release names.

## 4. Rollback

Rollback means rolling the application back to the previous release record's digests. Schema is **not**
rolled back, because migrations are forward-only.

1. Pick the previous release record (the last healthy one).
2. Confirm the previous application version runs against the **current** schema. A migration that removes or
   renames a column is not compatible with an old version. In that case rollback is not safe, and you move to
   a fix-forward or to [disaster-recovery.md](disaster-recovery.md) with the data owner's approval.
3. Redeploy the previous digests through the deploy workflow (or `helm rollback` once the chart exists).
   Verification still runs, and it still fails closed.
4. Re-run the post-deploy checks in section 3, step 4.
5. Record the rollback, the cause, and the time. Open an incident if the rollback was triggered by a
   production symptom (see [incident-response.md](incident-response.md)).

Ingress or certificate changes roll back through `infra/helm/bw-ingress` with the same steps, and the certificate
issuers in [ingress-tls.md](ingress-tls.md) are unaffected.

## 5. Cutover (LAUNCH)

Cutover is a planned deploy, with the rollback in section 4 ready beforehand. Before you start:

- The kill switch drill has passed in staging ([kill-switch.md](kill-switch.md)).
- The restore validation in [disaster-recovery.md](disaster-recovery.md) has passed at least once.
- The incident channel and on-call rota are set (see [incident-response.md](incident-response.md)).

## Validation

Do not change `last_validated` until these are done in the **staging** environment. They need AWS, a k3s cluster
and the deploy workflow, so they cannot run offline.

1. **Deploy drill:** deploy the current release to staging from the release record, through the real deploy
   workflow. Pass when pods are ready, `verify-images` is green and the post-deploy checks pass.
2. **Rollback drill:** deploy the previous release record's digests on top of the current release. Pass when the
   previous version is healthy and the schema check in section 4 holds.
3. **Negative drill:** feed `verify-images` an unsigned or mismatched digest. Pass when the deploy aborts before
   any rollout.

File the drill record (environment, versions, commands, results) in a ticket and link it here. Then set
`last_validated` to the drill date.
