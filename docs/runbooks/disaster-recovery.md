---
last_validated: never
---

# Disaster recovery runbook (INFRA, with DATA owners)

Owner: INFRA owns the backups and the DR skeleton. Read with
[§6 (repository layout)](../architecture/CONTEXT_PACK.md#6-repository-layout-create-exactly-this),
[§7 (domain model)](../architecture/CONTEXT_PACK.md#7-core-domain-model-tables-in-packagesdb-all-tenant-tables-have-tenant_id-uuid-not-null--rls) and
[§8.6 and §8.8 (tenant isolation, append-only audit)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).
The INFRA DR runbook skeleton is the authority for the mechanics once it lands. This document lists what must be
restored, in what order, and how to prove the restore worked.

> **Status: not validated, and most backup mechanisms are not built.** `last_validated: never` stays until a
> restore game-day has run in staging and its record is filed. The only backup mechanism in the repo is the S3
> storage module (INFRA-006). There is no database backup job, no Neo4j backup, no OpenBao snapshot and no
> restore tooling. Those are marked **not implemented**. Do not rely on this runbook to recover production until
> they exist and the game-day passes.

## 1. Backup inventory

| Store | What it holds | Backup mechanism today | Restore owner |
|---|---|---|---|
| PostgreSQL (tenant data, runs, findings, audit ledger, kill events) | System of record | **Not implemented** (no backup job or PITR config in the repo) | INFRA, with the data owner |
| Neo4j (attack graph and per-tenant memory) | Tenant-scoped graph | **Not implemented** | INFRA |
| S3 `*-evidence` | Evidence, under Object Lock COMPLIANCE, with a per-purpose KMS key | Object Lock is the protection. Versioning and retention are set by INFRA-006 | Cannot be deleted before retention ends, so there is nothing to restore |
| S3 `*-exports` | Customer exports | Versioned bucket, with non-current versions expiring after `exports_retention_days` | INFRA |
| S3 `*-backups` | Backup objects that the database and graph jobs will write | The bucket exists. Expires after `backups_retention_days`. No job writes to it yet | INFRA |
| S3 `*-transcripts` | Agent transcripts | Versioned, with expiry set by `transcripts_retention_days` | INFRA |
| OpenBao | Secrets and virtual-key material | **Not implemented.** Dev runs OpenBao in dev mode with no backup. Production needs an integrated-storage snapshot plan | INFRA and the security owner |
| Valkey | Idempotency keys, rate limits, caches | Not backed up. Losing it is an availability event, not a data loss, because it holds no system of record | INFRA |

Source for the buckets and their per-purpose KMS keys: `infra/tofu/modules/storage`.

## 2. RPO and RTO

**No RPO or RTO targets are set in the repo yet.** The INFRA DR runbook must set them. Until it does, use these
**proposed** values for the game-day to test against. They are not commitments:

| Store | Proposed RPO | Proposed RTO |
|---|---|---|
| PostgreSQL | 15 min (needs PITR) | 4 h |
| Neo4j | 24 h | 8 h |
| S3 evidence and exports | 0 (versioned, Object Lock) | Not applicable for restore |
| OpenBao | 24 h | 4 h |

If a store cannot meet its proposed target, record that as a gap for the launch review rather than changing the
target to fit the mechanism.

## 3. Restore order

Restore in dependency order so each step can be checked before the next:

1. **OpenBao**, so secrets are available. Secret values are never written to a ticket or a log.
2. **PostgreSQL**, to the newest consistent point. Apply forward-only migrations if the restored schema is behind
   the release record (see [db-migrations.md](db-migrations.md)). Never run a destructive migration during a restore.
3. **Neo4j**, from the matching point in time. Its tenant IDs must match PostgreSQL.
4. **Application**, from the release record digests (see [deploy-rollback.md](deploy-rollback.md)).
5. **Kill switch and egress.** Confirm both are healthy before any run is resumed. Restored runs that were active
   must be killed, not resumed (see [kill-switch.md](kill-switch.md)).

## 4. Restore validation checklist

A restore is not complete until every item passes. Partial restores are the common failure, so each item checks a
different part of the data:

- [ ] PostgreSQL row counts for every tenant table match the backup manifest, within the expected point-in-time gap.
- [ ] Every tenant has rows, and no row has a `tenant_id` that is not in the tenant table (RLS and foreign keys hold).
- [ ] The audit ledger hash chain verifies from the first event to the restore point. Check against
      `bw_audit_chain_head` for the restored head. **Note:** there is no chain-verify command in the repo yet, so this
      check is manual until one exists.
- [ ] Kill events and their audit events are present for every event before the restore point.
- [ ] Neo4j node and edge counts per tenant match the manifest, and tenant-scoped queries return only that tenant's data.
- [ ] Evidence objects are present, and their Object Lock retention is still active.
- [ ] Application health checks pass, and `bw_tenant_context_missing_total` does not increase after cutover.
- [ ] The kill drill from [kill-switch.md](kill-switch.md) passes against the restored environment.

## 5. Procedure: restore

1. Declare the incident and set the severity (see [incident-response.md](incident-response.md)).
2. Freeze deploys and new run starts for the affected scope.
3. Choose the restore point, and record it along with the backup manifest.
4. Restore in the order in section 3, running the checks in section 4 after each store.
5. If a check fails, stop and record which item failed. Do not continue to the next store on a partial restore.
6. When all checks pass, unfreeze, and record the restore time against the RTO.

## 6. Procedure: game-day

Run this in **staging**, once the backups exist:

1. Pick a restore point at least one hour in the past.
2. Restore into an empty staging environment, following section 5.
3. Run every item in section 4 and file the results.
4. Record the measured RPO (the gap between the restore point and the last committed write) and RTO (the time from
   start to unfreeze).
5. Fail the game-day if any check fails, or if a measured value is worse than the proposed target without an
   accepted gap.

File the game-day record in a ticket and link it here. Then set `last_validated` to the game-day date.

## 7. Partial restore

A partial restore is any restore where one store succeeds and another does not, or where a check in section 4 fails.
Treat it as a SEV1 (see [incident-response.md](incident-response.md)). Do not put the environment back into service
until the failed check passes, and never patch data by hand to make a check pass. Record every manual change in the
audit trail.

## Validation

Do not change `last_validated` until the game-day in section 6 has passed in staging. That needs real backups, a
staging restore target and AWS access, so it cannot run offline. Record the game-day in a ticket with the restore
point, every section 4 result and the measured RPO and RTO, then link it here and set `last_validated` to the
game-day date.
