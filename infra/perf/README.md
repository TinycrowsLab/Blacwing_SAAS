# Load-test harness (k6)

Shared [k6](https://grafana.com/docs/k6/latest/) harness for the PERF profiles (PERF-001, #320). Later profiles
(API, gateway, kill switch: PERF-002…007) add scripts under `k6/` and reuse the modules under `lib/`.

k6 runs in the goja JavaScript runtime, not Node. Scripts and `lib/` import only `k6/*` modules and plain
relative ES modules, and read configuration from `__ENV`.

## Layout

| Path | Holds |
|---|---|
| `k6/` | Runnable scripts. `baseline.js` is the shared probe used by every profile. |
| `lib/` | `config.js` (env parsing), `profiles.js` (load shapes and `options`), `thresholds.js` (presets), `auth.js` (Bearer and tenant headers, redaction), `output.js` (body capping, JSON summary). `harness.test.mjs` is the Node self-test. |
| `chaos/` | Fault-injection scenarios for PERF-004 and PERF-006. Empty until those land. |
| `fixtures/` | Offline target (`target.mjs`), the threshold-breach fixture and the `ci-smoke.mjs` orchestrator. |
| `results/` | JSON summaries, one file per run: `<script>-<ISO-8601 UTC>.json`. Git-ignored except `.gitkeep`. |
| `Makefile` | `smoke`, `load`, `stress`, `soak`, `ci-smoke`, `unit`. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PERF_BASE_URL` | `http://localhost:3000` | Target API. Must be an absolute `http(s)` URL. |
| `PERF_TOKEN` | none (required) | `bw_pat_…` or `bw_ci_…` API token. Missing or malformed: the run aborts before any request. |
| `PERF_TENANT_ID` | unset | Optional UUID, sent as `X-Tenant`. Use the dedicated perf tenant (CONTEXT_PACK §8.6). |
| `PERF_PROFILE` | `smoke` | `smoke` (1 VU, 30s), `load` (ramp to 50 VUs over 5m), `stress` (ramp to 300 VUs over 5m), `soak` (20 VUs for 1h). |
| `K6_PROMETHEUS_RW_SERVER_URL` | unset | Prometheus remote-write endpoint, for example `http://127.0.0.1:19090/api/v1/write` (the `obs` compose profile). Unreachable: a warning, and the JSON summary is still written. |

Tokens come only from the environment or a secret reference. The harness never prints them, and the summary is
redacted before it is written.

## Running

```sh
export PERF_TOKEN=bw_pat_...          # from the secret store, never committed
pnpm perf:smoke                        # or: pnpm perf:load | perf:stress | perf:soak
```

`pnpm perf:smoke` needs a running API at `PERF_BASE_URL`. The dev compose stack does not start the API; run it
with `pnpm dev` first.

Offline, without any stack (this is what CI can run):

```sh
pnpm perf:ci-smoke    # starts the seeded local target, runs smoke (must pass) and a deliberately tight fixture (must breach)
pnpm test:scripts     # includes the harness unit tests
```

## Thresholds

`http_req_duration` p(95) < 800 ms and p(99) < 1500 ms; `http_req_failed` rate < 1%; `checks` rate > 99%.
A breach makes k6 exit with code 99, so the run fails. `ci-smoke` asserts that exit code on the breach fixture.

## Prometheus

With `K6_PROMETHEUS_RW_SERVER_URL` set and reachable, the Makefile adds `--out experimental-prometheus-rw`.
k6 then writes its trend metrics as gauges per statistic, so the latency family is `k6_http_req_duration_p99`
(and `_p95`, `_avg`, ... with `K6_PROMETHEUS_RW_TREND_STATS`). Rates and counters keep their names, for example
`k6_checks_rate`, `k6_http_req_failed_rate` and `k6_http_reqs_total`. Query `{__name__=~"k6_http_req_duration.*"}`.
The `obs` profile enables the remote-write receiver (`--web.enable-remote-write-receiver`).

Verified on Prometheus v3.1.0 against the offline target: the reachable case stores `k6_*` series, and an
unreachable endpoint prints the warning and still writes the JSON summary. Native-histogram output
(`K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM`) was rejected by Prometheus with HTTP 500 in that check, so it is
not used.

## Installing k6 on the dev host

k6 is a single binary, not an apt package in this repo's bootstrap. Install the pinned release (v2.3.0 at the time
of writing) and verify its checksum from the release's `k6-v2.3.0-checksums.txt`:

```sh
curl -sSLO https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-linux-amd64.tar.gz
curl -sSLO https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-checksums.txt
grep linux-amd64.tar.gz k6-v2.3.0-checksums.txt | sha256sum -c -
tar -xzf k6-v2.3.0-linux-amd64.tar.gz && install -m 0755 k6-v2.3.0-linux-amd64/k6 ~/.local/bin/k6
```

## Scope

Load profiles only. Grafana panels belong to OBS, and provisioning the dev host belongs to INFRA.
