#!/usr/bin/env node
// Smoke test for the opt-in `obs` compose profile (DEVENV-009, `pnpm dev:deps:obs:smoke`).
//
// An example "app" emits one metric, one log record and one trace over OTLP/HTTP to the collector, then the
// script asserts each is visible in its backend (Prometheus, Loki, Tempo) and that Grafana has the
// provisioned datasources and starter dashboard. Requires `pnpm dev:deps:obs` to be running. The payloads
// carry no secrets and a unique marker per run; nothing leaves loopback.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NANOS_PER_MS = 1_000_000n;
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const SPAN_DURATION_MS = 5;
const RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOOKBACK_MS = 60_000;
const SMOKE_MARKER_BYTES = 4;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} name @param {string} marker */
const resource = (name, marker) => ({
  attributes: [
    { key: 'service.name', value: { stringValue: name } },
    { key: 'bw.smoke.marker', value: { stringValue: marker } },
  ],
});

/** @param {number} ms UTC epoch milliseconds, as nanoseconds in a string (OTLP JSON) */
export const nanos = (ms) => String(BigInt(ms) * NANOS_PER_MS);

/**
 * @param {{ service: string, marker: string, nowMs: number }} p
 * @returns {{ metrics: object, logs: object, traces: object, traceId: string, metricName: string }}
 */
export function buildPayloads({ service, marker, nowMs }) {
  const traceId = randomBytes(TRACE_ID_BYTES).toString('hex');
  const metricName = 'bw_obs_smoke_total';
  const t = nanos(nowMs);
  return {
    traceId,
    metricName,
    metrics: {
      resourceMetrics: [
        {
          resource: resource(service, marker),
          scopeMetrics: [
            {
              scope: { name: 'bw.obs-smoke' },
              metrics: [
                {
                  name: metricName,
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [{ asInt: '1', startTimeUnixNano: t, timeUnixNano: t }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    logs: {
      resourceLogs: [
        {
          resource: resource(service, marker),
          scopeLogs: [
            {
              scope: { name: 'bw.obs-smoke' },
              logRecords: [
                {
                  timeUnixNano: t,
                  severityText: 'INFO',
                  body: { stringValue: `obs smoke log ${marker}` },
                },
              ],
            },
          ],
        },
      ],
    },
    traces: {
      resourceSpans: [
        {
          resource: resource(service, marker),
          scopeSpans: [
            {
              scope: { name: 'bw.obs-smoke' },
              spans: [
                {
                  traceId,
                  spanId: randomBytes(SPAN_ID_BYTES).toString('hex'),
                  name: 'obs-smoke',
                  kind: 1,
                  startTimeUnixNano: t,
                  endTimeUnixNano: nanos(nowMs + SPAN_DURATION_MS),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Retries `fn` until it returns a truthy value or the deadline passes.
 * @param {string} what
 * @param {() => Promise<boolean>} fn
 * @param {number} timeoutMs
 */
export async function eventually(what, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // backend not ready yet
    }
    if (Date.now() > deadline) throw new Error(`FAIL: ${what} (timed out)`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

/** @param {string} envFile */
function readEnv(envFile) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
}

/** @param {string} url @param {object} body */
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${String(res.status)}`);
}

/** @param {string} envFile */
export async function smoke(envFile = path.join(ROOT, '.env')) {
  const env = { ...readEnv(envFile), ...process.env };
  const p = (/** @type {string} */ k, /** @type {string} */ d) => env[k] ?? d;
  const otlp = `http://127.0.0.1:${p('BW_DEV_OTEL_HTTP_PORT', '14318')}`;
  const prom = `http://127.0.0.1:${p('BW_DEV_PROMETHEUS_PORT', '19090')}`;
  const loki = `http://127.0.0.1:${p('BW_DEV_LOKI_PORT', '13100')}`;
  const tempo = `http://127.0.0.1:${p('BW_DEV_TEMPO_PORT', '13200')}`;
  const grafana = `http://127.0.0.1:${p('BW_DEV_GRAFANA_PORT', '13001')}`;
  const auth = `Basic ${Buffer.from(
    `${p('BW_DEV_GRAFANA_ADMIN_USER', 'admin')}:${p('BW_DEV_GRAFANA_ADMIN_PASSWORD', '')}`,
  ).toString('base64')}`;
  /** @type {string[]} */
  const passed = [];
  const ok = (/** @type {string} */ name) => {
    passed.push(name);
    process.stdout.write(`ok - ${name}\n`);
  };

  const marker = `smoke-${randomBytes(SMOKE_MARKER_BYTES).toString('hex')}`;
  const service = 'bw-obs-smoke';
  const nowMs = Date.now(); // UTC epoch; OTLP timestamps are always UTC nanoseconds
  const { metrics, logs, traces, traceId, metricName } = buildPayloads({ service, marker, nowMs });

  await eventually('collector health_check answers', async () => {
    return (await fetch(`http://127.0.0.1:${p('BW_DEV_OTEL_HEALTH_PORT', '13133')}/`)).ok;
  });
  ok('collector is healthy');

  await postJson(`${otlp}/v1/metrics`, metrics);
  await postJson(`${otlp}/v1/logs`, logs);
  await postJson(`${otlp}/v1/traces`, traces);
  ok('collector accepted OTLP/HTTP metrics, logs and traces');

  await eventually('metric visible in Prometheus', async () => {
    const q = encodeURIComponent(`${metricName}{service_name="${service}"}`);
    const body = /** @type {{ data: { result: unknown[] } }} */ (
      await (await fetch(`${prom}/api/v1/query?query=${q}`)).json()
    );
    return body.data.result.length > 0;
  });
  ok('metric is queryable in Prometheus');

  await eventually('log visible in Loki', async () => {
    const q = encodeURIComponent(`{service_name="${service}"} |= "${marker}"`);
    const start = String(BigInt(nowMs - LOOKBACK_MS) * NANOS_PER_MS);
    const body = /** @type {{ data: { result: unknown[] } }} */ (
      await (await fetch(`${loki}/loki/api/v1/query_range?query=${q}&start=${start}`)).json()
    );
    return body.data.result.length > 0;
  });
  ok('log is queryable in Loki');

  await eventually('trace visible in Tempo', async () => {
    return (await fetch(`${tempo}/api/traces/${traceId}`)).ok;
  });
  ok('trace is retrievable from Tempo');

  const sources = /** @type {{ type: string }[]} */ (
    await (await fetch(`${grafana}/api/datasources`, { headers: { authorization: auth } })).json()
  );
  for (const type of ['prometheus', 'loki', 'tempo']) {
    if (!sources.some((s) => s.type === type)) throw new Error(`FAIL: grafana datasource ${type}`);
  }
  ok('grafana has the Prometheus, Loki and Tempo datasources provisioned');

  const found = /** @type {{ uid: string }[]} */ (
    await (
      await fetch(`${grafana}/api/search?query=Blackwing%20overview`, {
        headers: { authorization: auth },
      })
    ).json()
  );
  if (!found.some((d) => d.uid === 'bw-overview')) throw new Error('FAIL: starter dashboard');
  ok('grafana has the provisioned starter dashboard');
  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const passed = await smoke();
    process.stdout.write(`\n${String(passed.length)} checks passed\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
