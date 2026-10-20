// Tests for the opt-in `obs` compose profile (DEVENV-009): static checks of the compose file, collector,
// Prometheus and Grafana provisioning, plus the smoke test's payload builders. The live check (metric, log
// and trace visible in each backend) is `pnpm dev:deps:obs:smoke` against a running profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { COMPOSE_FILE, OBS_SERVICES, main } from './dev-deps.mjs';
import { buildPayloads, eventually, nanos } from './obs-smoke.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OBS_DIR = path.join(path.dirname(COMPOSE_FILE), 'obs');
const MIN_BLOCKED_PATTERNS = 3;
const MIN_DASHBOARD_PANELS = 4;
const TRACE_ID_HEX = 32;
const SPAN_ID_HEX = 16;

/** @param {string} f */
const read = (f) => readFileSync(f, 'utf8');

/**
 * Walks a parsed document by key path (array indexes are numeric keys); returns undefined when absent.
 * @param {unknown} doc
 * @param {...(string | number)} keys
 * @returns {unknown}
 */
function at(doc, ...keys) {
  let cur = doc;
  for (const k of keys) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = /** @type {Record<string | number, unknown>} */ (cur)[k];
  }
  return cur;
}

/** @param {unknown} v @returns {unknown[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {unknown} v @returns {string[]} */
const keys = (v) => (typeof v === 'object' && v !== null ? Object.keys(v) : []);

/** @param {string} f */
const yaml = (f) => /** @type {unknown} */ (parse(read(path.join(OBS_DIR, f))));

const compose = /** @type {unknown} */ (parse(read(COMPOSE_FILE)));
/** @param {string} svc @param {...(string | number)} rest */
const svcAt = (svc, ...rest) => at(compose, 'services', svc, ...rest);

describe('obs compose profile', () => {
  it('defines the five observability services, all behind the obs profile', () => {
    for (const svc of OBS_SERVICES) {
      assert.deepEqual(svcAt(svc, 'profiles'), ['obs'], `${svc} must be profile obs`);
    }
  });

  it('keeps the default (core) set out of the obs profile: pnpm dev:deps cannot start it', () => {
    for (const name of keys(at(compose, 'services'))) {
      if (OBS_SERVICES.includes(name)) continue;
      assert.ok(!arr(svcAt(name, 'profiles')).includes('obs'), `${name} must not be in obs`);
    }
    const pkg = /** @type {unknown} */ (JSON.parse(read(path.join(ROOT, 'package.json'))));
    assert.equal(at(pkg, 'scripts', 'dev:deps'), 'node scripts/dev-deps.mjs up');
    assert.equal(at(pkg, 'scripts', 'dev:deps:obs'), 'node scripts/dev-deps.mjs obs');
    const src = read(path.join(ROOT, 'scripts/dev-deps.mjs'));
    const upBranch = /if \(cmd === 'up'\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    assert.ok(upBranch.length > 0 && !upBranch.includes('obs'));
  });

  it('pins every obs image by tag and digest, and publishes ports on loopback only', () => {
    for (const svc of OBS_SERVICES) {
      assert.match(str(svcAt(svc, 'image')), /:[\w.-]+@sha256:[0-9a-f]{64}$/, svc);
      for (const port of arr(svcAt(svc, 'ports'))) {
        assert.match(
          str(port),
          /^127\.0\.0\.1:\$\{BW_DEV_[A-Z_]+:-\d+\}:\d+$/,
          `${svc} ${str(port)}`,
        );
      }
      assert.equal(svcAt(svc, 'container_name'), undefined);
    }
  });

  it('uses the fixed host-port map and keeps every port overridable (port conflicts)', () => {
    const published = OBS_SERVICES.flatMap((s) => arr(svcAt(s, 'ports')).map((x) => str(x)));
    const expected = ['14317', '14318', '19090', '13100', '13200', '13001'];
    const env = read(path.join(ROOT, '.env.example'));
    for (const p of expected) {
      assert.ok(
        published.some((x) => x.includes(`:-${p}}`)),
        p,
      );
      assert.match(env, new RegExp(`^BW_DEV_[A-Z_]+=${p}$`, 'm'));
    }
    assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:14318$/m);
  });

  it('persists data in named volumes and bounds resource use (resource pressure)', () => {
    const volumes = keys(at(compose, 'volumes'));
    for (const v of ['promdata', 'lokidata', 'tempodata', 'grafanadata']) {
      assert.ok(volumes.includes(v), v);
    }
    for (const svc of OBS_SERVICES) {
      assert.ok(svcAt(svc, 'deploy', 'resources', 'limits', 'memory'), `${svc} memory limit`);
    }
  });

  it('gets the Grafana admin password from .env, never from the file', () => {
    const pw = str(svcAt('grafana', 'environment', 'GF_SECURITY_ADMIN_PASSWORD'));
    assert.match(pw, /^\$\{BW_DEV_GRAFANA_ADMIN_PASSWORD:\?/);
    assert.match(read(path.join(ROOT, '.env.example')), /^BW_DEV_GRAFANA_ADMIN_PASSWORD=$/m);
  });

  it('reset also drops the obs profile volumes', () => {
    assert.match(read(path.join(ROOT, 'scripts/dev-deps.mjs')), /'--profile', 'obs', 'down', '-v'/);
  });
});

describe('otel collector config', () => {
  const cfg = yaml('otel-collector.yaml');
  const pipeline = (/** @type {string} */ n) => at(cfg, 'service', 'pipelines', n);

  it('receives OTLP gRPC and HTTP and routes metrics to Prometheus, logs to Loki, traces to Tempo', () => {
    assert.ok(at(cfg, 'receivers', 'otlp', 'protocols', 'grpc'));
    assert.ok(at(cfg, 'receivers', 'otlp', 'protocols', 'http'));
    assert.deepEqual(at(pipeline('metrics'), 'exporters'), ['prometheus']);
    assert.deepEqual(at(pipeline('logs'), 'exporters'), ['otlphttp/loki']);
    assert.deepEqual(at(pipeline('traces'), 'exporters'), ['otlp/tempo']);
  });

  it('only exports to services on the dev network (no external egress)', () => {
    for (const t of [
      at(cfg, 'exporters', 'otlphttp/loki', 'endpoint'),
      at(cfg, 'exporters', 'otlp/tempo', 'endpoint'),
    ]) {
      assert.match(str(t), /^(http:\/\/)?(loki|tempo):\d+/);
    }
    assert.deepEqual(keys(at(cfg, 'exporters')).sort(), [
      'otlp/tempo',
      'otlphttp/loki',
      'prometheus',
    ]);
  });

  it('transports only: redaction on traces is defence in depth, upstream redaction is the control', () => {
    for (const n of ['metrics', 'logs', 'traces']) {
      const procs = arr(at(pipeline(n), 'processors'));
      assert.ok(procs.includes('memory_limiter') && procs.includes('batch'), n);
    }
    assert.ok(arr(at(pipeline('traces'), 'processors')).includes('redaction'));
    assert.equal(at(cfg, 'processors', 'redaction', 'allow_all_keys'), true);
    assert.ok(
      arr(at(cfg, 'processors', 'redaction', 'blocked_values')).length >= MIN_BLOCKED_PATTERNS,
    );
  });

  it('exposes a health_check extension used for readiness', () => {
    assert.ok(arr(at(cfg, 'service', 'extensions')).includes('health_check'));
    assert.match(str(at(cfg, 'extensions', 'health_check', 'endpoint')), /:13133$/);
  });

  it('edge case: collector config errors are caught by `otelcol validate`', () => {
    const image = str(svcAt('otel-collector', 'image'));
    const run = (/** @type {string} */ dir) =>
      spawnSync(
        'docker',
        ['run', '--rm', '-v', `${dir}:/o:ro`, image, 'validate', '--config=/o/otel-collector.yaml'],
        { encoding: 'utf8' },
      );
    const good = run(OBS_DIR);
    if (good.error) return; // docker unavailable on this host: the live smoke covers it
    assert.equal(good.status, 0, good.stderr);
    const bad = run(path.join(ROOT, 'scripts/fixtures/obs-bad-collector'));
    assert.notEqual(bad.status, 0);
  });
});

describe('prometheus and grafana provisioning', () => {
  const datasources = arr(
    at(yaml('grafana/provisioning/datasources/datasources.yaml'), 'datasources'),
  );

  it('scrapes the collector exporter and the dev backends', () => {
    const names = arr(at(yaml('prometheus.yml'), 'scrape_configs')).map((j) => at(j, 'job_name'));
    for (const n of ['otel-collector', 'prometheus', 'loki', 'tempo', 'minio', 'temporal']) {
      assert.ok(names.includes(n), n);
    }
  });

  it('provisions the Prometheus, Loki and Tempo datasources', () => {
    assert.deepEqual(datasources.map((d) => str(at(d, 'type'))).sort(), [
      'loki',
      'prometheus',
      'tempo',
    ]);
  });

  it('provisions a starter dashboard whose panels reference provisioned datasources', () => {
    const dash = /** @type {unknown} */ (
      JSON.parse(read(path.join(OBS_DIR, 'grafana/dashboards/blackwing-overview.json')))
    );
    assert.equal(at(dash, 'uid'), 'bw-overview');
    const uids = datasources.map((d) => at(d, 'uid'));
    const panels = arr(at(dash, 'panels'));
    assert.ok(panels.length >= MIN_DASHBOARD_PANELS);
    for (const panel of panels) {
      assert.ok(uids.includes(at(panel, 'datasource', 'uid')), str(at(panel, 'title')));
    }
    const text = JSON.stringify(panels);
    assert.match(text, /bw_runs_started_total/);
    assert.match(text, /bw_agent_sessions_total/);
    const provider = at(yaml('grafana/provisioning/dashboards/dashboards.yaml'), 'providers', 0);
    assert.equal(at(provider, 'options', 'path'), '/var/lib/grafana/dashboards');
  });
});

describe('obs smoke payloads', () => {
  const p = buildPayloads({ service: 'svc', marker: 'm1', nowMs: 1_700_000_000_000 });

  it('builds a UTC nanosecond OTLP metric, log and trace carrying the marker', () => {
    assert.equal(nanos(1_700_000_000_000), '1700000000000000000');
    assert.match(JSON.stringify(p.logs), /obs smoke log m1/);
    assert.equal(p.traceId.length, TRACE_ID_HEX);
    const span = at(p.traces, 'resourceSpans', 0, 'scopeSpans', 0, 'spans', 0);
    assert.equal(at(span, 'traceId'), p.traceId);
    assert.equal(str(at(span, 'spanId')).length, SPAN_ID_HEX);
    assert.equal(
      at(p.metrics, 'resourceMetrics', 0, 'scopeMetrics', 0, 'metrics', 0, 'name'),
      p.metricName,
    );
  });

  it('eventually retries until true and fails with a clear message on timeout', async () => {
    let n = 0;
    await eventually('x', () => Promise.resolve(++n >= 2), 5000);
    assert.equal(n, 2);
    await assert.rejects(
      eventually('never', () => Promise.resolve(false), 10),
      /FAIL: never/,
    );
  });

  it('dev-deps rejects unknown commands', async () => {
    assert.equal(await main(['explode']), 2);
  });
});
