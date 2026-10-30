# Blackwing umbrella chart (#44)

Deploys the long-running applications on the k3s cluster: `web`, `api`, `worker`, `model-gateway`,
`egress-gateway`, `session-manager` and `sandbox-controller`. The per-run `bw-sandbox` image is not a
Deployment here. `sandbox-controller` spawns it at runtime and receives its digest through
`SBX_IMAGE_DIGEST`.

## Images come only from the CI hand-off

No template names an image. Each `image:` reads `global.images.<app>`, and the values schema accepts only
`ghcr.io/tinycrowslab/bw-<app>@sha256:<64 hex>`. A tag, another registry, or a missing entry fails the render.

Render the hand-off values, then install:

```sh
node scripts/helm-images.mjs --images-json <ci-007 images.json> --out /tmp/bw-images.yaml
helm upgrade --install blackwing infra/helm/blackwing -n bw-system --atomic \
  -f infra/helm/blackwing/values-prod.yaml -f /tmp/bw-images.yaml
```

- `images.json` is CI-007's output (`ghcr.io/tinycrowslab/bw-<service>@sha256:...`).
- `--sandbox-digest` defaults to `infra/docker/sandbox/IMAGE_DIGEST`, which IMAGE-012 surfaces. It must hold
  a `ghcr.io/tinycrowslab/bw-sandbox@sha256:...` reference. An empty file fails.
- Pick the environment with `values-dev.yaml`, `values-staging.yaml` or `values-prod.yaml`. Each sets
  `global.environment`, which the render requires.

## Shape of every app

- Probes: startup, liveness and readiness hit `/healthz` and `/readyz` on the app's named port.
- Hardening: non-root (`runAsUser` per app, the egress gateway runs as distroless `nonroot`), read-only root
  filesystem with an `emptyDir` at `/tmp`, all capabilities dropped, `RuntimeDefault` seccomp, and
  `automountServiceAccountToken: false` except for `sandbox-controller`, which creates sandbox pods.
- Configuration: a ConfigMap of non-secret values. Secrets are read only through `envFrom: secretRef` with
  `optional: false`, so a missing Secret stops the pod at creation. The chart renders no Secret object, and
  `apps.<app>.env` refuses keys that look like secrets.
- Placement: `blackwing.io/pool=control-plane`, except the egress gateway on `egress`. No pod tolerates the
  sandbox pool.
- Scaling: HPAs and PDBs are per environment (on in staging and prod, off in dev).

## API and the Run Broker

`api` exposes `/v1` and `/graphql` on the `api` Service, the only paths `bw-ingress` routes. The Run Broker
(`/internal/broker`) has its own `api-broker` Service, which is ClusterIP and never routed. The chart renders no
Ingress or IngressRoute. NetworkPolicies (INFRA-011) restrict the broker to the sandbox network.

## Migrations

`db-migrate` is a Job and a `pre-install,pre-upgrade` hook. It runs the Drizzle migration entrypoint with the
api image and blocks the release if it fails. `helm upgrade --atomic` then rolls the release back. The Job's
command is in `apps.api.migrations.command`, and the DB epic owns the entrypoint.

## Tests

`node --test scripts/helm-blackwing.test.mjs` (also run by `pnpm test:scripts`) lints the chart for every
environment, checks the schema negatives, and checks the rendered objects: probes, hardening, digests, the
hand-off wiring (`SBX_IMAGE_DIGEST`), the broker exposure, the hook, and the no-hardcoded-image rule.
It also runs `kubeconform` when it is on the PATH.

Not covered offline: a real `helm install` on a kind or k3s cluster, where every pod must reach Ready. That
needs the published images and is the integration half. Probes and `/readyz` behaviour are proven by each
app's own tests.
