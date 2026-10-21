# Runbook: public ingress, TLS and cert-manager (INFRA-012)

Files: `infra/k3s/cert-manager/` (install, values, probes), `infra/helm/bw-ingress/` (issuers, certificates,
middlewares, routes, alerts), `infra/tofu/modules/dns` (`cert_manager_policy_arn`). Self-tests:
`node --test scripts/ingress.test.mjs` (offline, `helm template` + kubeconform).

## Install

1. Apply tofu so the app zone and the solver policy exist; note `dns_app_zone_id` and
   `dns_cert_manager_policy_arn`, and attach the policy to cert-manager's AWS identity.
2. `infra/k3s/cert-manager/install.sh --domain <domain> --email <ops mailbox> --zone-id <zone id>`
   installs cert-manager (pinned in `versions.env`) and `bw-ingress` on **Let's Encrypt staging**.
3. Wait for `kubectl -n bw-system get certificate` to show `Ready` for `app-tls` and `api-tls`.
4. `infra/k3s/cert-manager/verify-ingress.sh <domain> --insecure-staging` from outside the cluster.
5. Only after the same release passed on staging, re-run with `--prod`, then
   `verify-ingress.sh <domain>` (full chain validation). Production issuance happens on merge to the
   release path, never while iterating (Let's Encrypt rate limits).

## What the probes prove (acceptance criteria)

| Criterion | Probe |
|---|---|
| Valid LE chain, HTTP redirects to HTTPS | `verify-ingress.sh` (308 to `https://host`) |
| HSTS, nosniff, frame protection | `curl -I` checks in `verify-ingress.sh` |
| TLS 1.2 and above only | `openssl s_client -tls1_2` accepted, `-tls1_1`/`-tls1` refused |
| `/internal/broker` unreachable externally | 404 or refused on `api.<domain>`; any other status fails the script |
| Auto-renewal | staging renewal drill below |

## Staging renewal drill

`install.sh ... --renewal-drill` sets `renewBefore: 2159h` on a 2160h staging certificate, so cert-manager
renews within minutes. Observe `kubectl -n bw-system describe certificate app-tls` (events `Issuing`, `Renewing`,
then a new `notAfter`) and the metric `certmanager_certificate_renewal_timestamp_seconds`. Never combine with
`--prod` (the script refuses).

## Failure modes

- **DNS-01 propagation delay**: cert-manager checks only public resolvers (`--dns01-recursive-nameservers-only`)
  and retries with back-off. Look at `kubectl describe challenge`. Persistent `AccessDenied` means the solver
  policy is not attached.
- **Rate limited by Let's Encrypt**: stay on staging, wait for the window, do not delete and recreate issuers.
- **Renewal failure / near expiry**: alerts `BlackwingCertificateExpiringSoon` (under 14 days left) and
  `BlackwingCertificateNotReady` page on-call. The public host keeps serving the old certificate until it expires.
- **Header downgrade**: `secure-headers` and the TLS options are also set as defaults on the `websecure` entry
  point (HelmChartConfig for the k3s Traefik), so a new route that forgets them still gets them.
- **Broker exposure**: the chart refuses to render such a path; the Loki rule
  `BlackwingBrokerPathRequestedViaIngress` pages on any `/internal/*` request seen by the ingress, even if answered 404.
- **HSTS lock-in**: read `infra/k3s/cert-manager/README.md` before enabling `includeSubDomains` on a shared domain.

## Internal UIs

Temporal UI, Grafana and OpenBao UI are not routed. To publish one, set `internalUis.<name>` with an
`ipAllowList` (never `0.0.0.0/0`) and an `authMiddleware` naming an existing authenticating Traefik Middleware
(for example forward-auth to Keycloak). The chart refuses to render otherwise.
