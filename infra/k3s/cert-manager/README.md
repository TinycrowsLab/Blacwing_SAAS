# cert-manager and the public ingress (INFRA-012)

Installs cert-manager at a pinned chart version and the `bw-ingress` chart (`infra/helm/bw-ingress`):
`letsencrypt-staging` and `letsencrypt-prod` ClusterIssuers (DNS-01 through Route53), certificates for
`app.<domain>` and `api.<domain>`, hardened Traefik TLS options, security-header, rate-limit and in-flight
middlewares, and IngressRoutes for the web console and the public API only. Operations: see
[`docs/runbooks/ingress-tls.md`](../../../docs/runbooks/ingress-tls.md).

```sh
infra/k3s/cert-manager/install.sh --domain D --email E --zone-id Z            # staging (default)
infra/k3s/cert-manager/install.sh --domain D --email E --zone-id Z --prod     # production
infra/k3s/cert-manager/install.sh ... --renewal-drill                         # staging, near-expiry renewal
infra/k3s/cert-manager/install.sh ... --dry-run                               # helm template only
infra/k3s/cert-manager/verify-ingress.sh D [--insecure-staging]               # external probes
```

## Route53 solver permissions

Attach the policy from `tofu output dns_cert_manager_policy_arn` to the identity cert-manager runs as (the
k3s node role, or a workload role). It allows only `route53:ChangeResourceRecordSets` for TXT records named
`_acme-challenge.*` in the app zone, plus `GetChange`, `ListResourceRecordSets` on the zone and
`ListHostedZonesByName`. It cannot change A or NS records (including the `oob.<domain>` delegation) or any
other zone. No static AWS keys are used by default; `acme.route53.credentialsSecret` is a fallback only, and
the Secret must be created out of band (never in git).

## HSTS implications

`secure-headers` sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Browsers then refuse
plain HTTP for `<domain>` and every subdomain for a year, and the header cannot be revoked early. Before
enabling it on a domain that also hosts anything HTTP-only, set `headers.stsIncludeSubdomains=false`. The chart
never sets `preload`. The minimum is 15552000 seconds; the chart refuses lower values.

## What is deliberately not routed

The Run Broker (`/internal/broker`) has no IngressRoute and the chart refuses any public path under
`/internal` or naming the broker. It must be served by a separate ClusterIP Service (INFRA-009) that
NetworkPolicies (INFRA-011) limit to the sandbox network. Temporal UI, Grafana and OpenBao UI are
cluster-internal. `internalUis` can publish one only behind an IP allowlist and an authenticating middleware.
