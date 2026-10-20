# Runbook: published egress-IP list (INFRA-015)

Code: `infra/tofu/modules/egress-ips`, called from each `infra/tofu/environments/<env>/egress_ips.tf`.
Validator and drift check: `scripts/check-egress-ips.mjs`. Customer-facing page: [`docs/user/egress-ips.md`](../user/egress-ips.md).

All target traffic leaves through the egress gateway behind the static NAT EIPs created by the vpc module
(INFRA-002, output `egress_ips`). This document is how customers learn those addresses (pack
[§8 #2](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch)
attribution).

## What exists

| Piece | Detail |
|---|---|
| URL | `https://egress.<domain>/.well-known/blackwing-egress-ips.json` (label `egress`, set by `hostname_label`) |
| Storage | Private S3 bucket `bw-<env>-egress-ips` (public access blocked, TLS-only policy, versioned). Only this one object is readable, and only by the CloudFront distribution (OAC + `AWS:SourceArn`). |
| Serving | CloudFront, `https-only` (plain HTTP is refused, never redirected), TLS 1.2+, ACM certificate in `us-east-1`, Route53 A/AAAA aliases. No dependency on the application, so firewall automation keeps working during an app outage. |
| Headers | `Content-Type: application/json`, `Cache-Control: public, max-age=3600`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, CORS `GET`/`HEAD` from any origin. |

## Document (schema version 1)

```json
{
  "version": 1,
  "lastUpdated": "2026-10-20T10:00:00Z",
  "egressIps": ["198.51.100.7/32", "203.0.113.20/32"],
  "notes": "Source addresses of all Blackwing target traffic. ..."
}
```

`egressIps` is sorted, `/32` only, never empty. `lastUpdated` is stamped by a `terraform_data` resource that is
replaced only when the address set changes, so a re-apply with the same EIPs keeps the same value.

## Why it cannot drift

The module takes the vpc module's `egress_ips` output as its only input and renders the JSON in the same plan.
Nothing is hand-edited. Its variable validation refuses an empty list and any private, loopback, link-local, CGNAT
or multicast address, so an internal address can never be published.

Checks:

- `tofu test` (`infra/tofu/scripts/check.sh modules/egress-ips`): published list equals the input set, schema,
  no private ranges, `lastUpdated` tied to the set, TLS-only, headers, private bucket.
- `node scripts/check-egress-ips.mjs drift <url> <(tofu output -json egress_ips)` against the live URL, from the
  environment root. It fails when the published set differs from the real EIPs, and it validates the schema. Run
  it after every apply and on a schedule once the online pipeline exists (gated on `BW_ONLINE`, see the porting
  issue "Port to online: egress-IP list live checks"). A non-zero exit must page the infrastructure on-call.

## Changing the EIPs

1. Change the vpc module and `tofu apply` (reviewed plan). The module republishes the document in the same apply.
2. The CDN and clients may serve the old list for up to `cache_ttl_seconds` (1 hour). Tell customers before a
   planned change; keep old EIPs attached until the TTL has passed.
3. Run the drift check against the URL.

## Observability

CloudFront publishes `Requests`, `4xxErrorRate` and `5xxErrorRate` to CloudWatch (namespace `AWS/CloudFront`,
region `us-east-1`, dimension `DistributionId` = output `distribution_id`). `Requests` is the fetch volume metric.
S3 access logs go to the bootstrap log bucket under `s3/bw-<env>-egress-ips/`. Changes are audited through the IaC
pipeline (reviewed plans, CloudTrail).
