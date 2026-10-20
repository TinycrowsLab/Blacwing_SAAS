// DEVENV-010 (#164): dev:deps orchestration, wait-for-health and dev:doctor, against a mocked compose.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DOCTOR_ONE_SHOTS, DOCTOR_SERVICES, doctor, endpointLines } from './dev-doctor.mjs';
import {
  BOOTSTRAP_ORDER,
  CORE_SERVICES,
  DevDepsError,
  RESET_HINT,
  acquireLock,
  orchestrateUp,
  preflight,
} from './dev-orchestrate.mjs';
import {
  classify,
  envSecrets,
  parseArgs,
  parseComposePs,
  redact,
  waitForHealth,
} from './wait-for-health.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

/** @param {Record<string, { State: string, Health?: string, ExitCode?: number }>} m */
function psJson(m) {
  return Object.entries(m)
    .map(([Service, e]) => JSON.stringify({ Service, Health: '', ExitCode: 0, ...e }))
    .join('\n');
}

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'bw-devenv010-'));
}

/**
 * A fake `bwdev` compose project. Services become healthy `delay` polls after `up`.
 * @param {{ unhealthy?: string[], delay?: number, failOnce?: string[], jobExit?: Record<string, number> }} [opts]
 */
function fakeStack(opts = {}) {
  /** @type {Map<string, { State: string, Health: string, ExitCode: number, polls: number }>} */
  const state = new Map();
  /** @type {string[]} */
  const calls = [];
  const failOnce = new Set(opts.failOnce ?? []);
  const oneShotExit = new Set(['temporal-bootstrap', 'keycloak-db']);
  /** @param {string} svc */
  const start = (svc) => {
    if (!state.has(svc))
      state.set(svc, { State: 'running', Health: 'starting', ExitCode: 0, polls: 0 });
    if (svc === 'keycloak') start('keycloak-db');
  };
  /** @type {import('./wait-for-health.mjs').Runner} */
  const compose = (args) => {
    const a = args.filter((x, i) => x !== '--profile' && args[i - 1] !== '--profile');
    calls.push(a.join(' '));
    if (a[0] === 'up') {
      for (const svc of a.slice(2)) start(svc);
      return ok();
    }
    if (a[0] === 'ps') {
      /** @type {Record<string, { State: string, Health: string, ExitCode: number }>} */
      const view = {};
      for (const [svc, e] of state) {
        e.polls += 1;
        if (e.polls > (opts.delay ?? 1) && e.Health === 'starting') {
          if (opts.unhealthy?.includes(svc)) e.Health = 'unhealthy';
          else if (oneShotExit.has(svc))
            Object.assign(e, { State: 'exited', Health: '', ExitCode: opts.jobExit?.[svc] ?? 0 });
          else e.Health = 'healthy';
        }
        view[svc] = { State: e.State, Health: e.Health, ExitCode: e.ExitCode };
      }
      return ok(psJson(view));
    }
    if (a[0] === 'exec') {
      if (failOnce.delete(a[2] ?? '')) return { status: 1, stdout: '', stderr: 'boom' };
      return ok();
    }
    if (a[0] === 'logs')
      return ok(
        'starting\nBW_DEV_X_PASSWORD=hunter2hunter2\nRoot Token: s.abc\nsupersecretvalue123 leaked\n',
      );
    return ok();
  };
  /** @type {string[]} */
  const hostCalls = [];
  return {
    state,
    calls,
    hostCalls,
    /** @param {string} lockFile @param {Partial<import('./dev-orchestrate.mjs').Deps>} [over] */
    deps: (lockFile, over = {}) => ({
      compose,
      docker: () => ok(`${String(16 * 1024 ** 3)} 8`),
      host: (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
        hostCalls.push([cmd, ...args].join(' '));
        if (failOnce.delete('openbao')) return 1;
        return 0;
      },
      waitHttp: () => Promise.resolve(),
      secrets: ['supersecretvalue123'],
      env: {},
      out: () => undefined,
      sleep: () => Promise.resolve(),
      intervalMs: 0,
      lockFile,
      ...over,
    }),
  };
}

describe('wait-for-health (DEVENV-010)', () => {
  it('parses both compose ps JSON shapes', () => {
    const lines = psJson({ postgres: { State: 'running', Health: 'healthy' } });
    assert.deepEqual(parseComposePs(lines), parseComposePs(`[${lines}]`));
    assert.equal(parseComposePs(lines)[0]?.Health, 'healthy');
    assert.deepEqual(parseComposePs(''), []);
  });

  it('classifies long-running services and one-shot jobs', () => {
    const e = (/** @type {string} */ State, Health = '', ExitCode = 0) => ({
      Service: 's',
      State,
      Health,
      ExitCode,
    });
    assert.equal(classify(e('running', 'healthy'), false).verdict, 'ready');
    assert.equal(classify(e('running', ''), false).verdict, 'ready');
    assert.equal(classify(e('running', 'starting'), false).verdict, 'starting');
    assert.equal(classify(e('running', 'unhealthy'), false).verdict, 'failed');
    assert.equal(classify(e('exited', '', 1), false).verdict, 'failed');
    assert.equal(classify(e('exited', '', 0), true).verdict, 'ready');
    assert.equal(classify(e('exited', '', 3), true).verdict, 'failed');
    assert.equal(classify(e('running', 'healthy'), true).verdict, 'ready');
    assert.equal(classify(undefined, false).verdict, 'starting');
  });

  it('polls until every service is ready and prints a status table', async () => {
    let n = 0;
    /** @type {string[]} */
    const printed = [];
    const r = await waitForHealth({
      services: ['postgres', 'valkey'],
      ps: () => {
        n += 1;
        return psJson({
          postgres: { State: 'running', Health: 'healthy' },
          valkey: { State: 'running', Health: n < 3 ? 'starting' : 'healthy' },
        });
      },
      sleep: () => Promise.resolve(),
      out: (s) => printed.push(s),
    });
    assert.equal(r.ok, true);
    assert.equal(n, 3);
    assert.match(printed.join(''), /SERVICE\s+STAT\s+DETAIL[\s\S]*valkey\s+ok\s+healthy/);
  });

  it('edge case: one service unhealthy -> fails fast naming it, with a redacted log tail', async () => {
    /** @type {string[]} */
    const printed = [];
    const r = await waitForHealth({
      services: ['postgres', 'neo4j'],
      ps: () =>
        psJson({
          postgres: { State: 'running', Health: 'healthy' },
          neo4j: { State: 'running', Health: 'unhealthy' },
        }),
      logs: (svc) =>
        redact(`${svc} line\npassword=hunter2\nvalue sekret-123456 here`, ['sekret-123456']),
      sleep: () => Promise.reject(new Error('must not sleep')),
      out: (s) => printed.push(s),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ['neo4j']);
    assert.match(r.reason, /unhealthy: neo4j/);
    const text = printed.join('');
    assert.match(text, /last log lines of neo4j/);
    assert.doesNotMatch(text, /hunter2|sekret-123456/);
  });

  it('edge case: partial bring-up -> times out naming the pending services', async () => {
    let t = 0;
    const r = await waitForHealth({
      services: ['postgres', 'keycloak'],
      ps: () =>
        psJson({
          postgres: { State: 'running', Health: 'healthy' },
          keycloak: { State: 'running', Health: 'starting' },
        }),
      logs: () => 'tail',
      timeoutMs: 5000,
      now: () => (t += 1000),
      sleep: () => Promise.resolve(),
      out: () => undefined,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ['keycloak']);
    assert.match(r.reason, /timed out waiting for: keycloak/);
  });

  it('a missing service never counts as healthy', async () => {
    let t = 0;
    const r = await waitForHealth({
      services: ['openbao'],
      ps: () => '',
      timeoutMs: 1,
      now: () => (t += 10),
      sleep: () => Promise.resolve(),
      out: () => undefined,
    });
    assert.equal(r.ok, false);
  });

  it('parses CLI arguments', () => {
    assert.deepEqual(parseArgs(['--timeout', '10', 'postgres', '--one-shot', 'minio-init']), {
      timeoutMs: 10_000,
      services: ['postgres'],
      oneShots: ['minio-init'],
    });
    assert.throws(() => parseArgs([]), /no services/);
    assert.throws(() => parseArgs(['--bogus']), /unknown/);
  });

  it('collects credential values from .env for log scrubbing', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, '.env');
      writeFileSync(
        f,
        'BW_DEV_POSTGRES_PASSWORD=abcdef123\nBW_DEV_POSTGRES_PORT=15432\nX_TOKEN=\n',
      );
      assert.deepEqual(envSecrets(f), ['abcdef123']);
      assert.deepEqual(envSecrets(path.join(dir, 'none')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lockfile (edge case: concurrent invocations)', () => {
  it('refuses a second run while the holder is alive, and releases cleanly', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, 'lock');
      const release = acquireLock(f, { pid: 4242, isAlive: () => true });
      assert.throws(() => acquireLock(f, { pid: 4343, isAlive: () => true }), /pid 4242/);
      release();
      assert.equal(existsSync(f), false);
      acquireLock(f, { pid: 4343 })();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a stale lock left by a killed run', () => {
    const dir = tmpDir();
    try {
      const f = path.join(dir, 'lock');
      writeFileSync(f, '999999\n');
      const release = acquireLock(f, { pid: 5555, isAlive: () => false });
      assert.equal(readFileSync(f, 'utf8').trim(), '5555');
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an overlapping dev:deps run fails before touching compose', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      writeFileSync(lockFile, `${String(process.pid)}\n`);
      const stack = fakeStack();
      await assert.rejects(
        orchestrateUp(stack.deps(lockFile), { lockFile }),
        /another dev:deps run/,
      );
      assert.deepEqual(stack.calls, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('preflight (edge case: Docker not running / insufficient resources)', () => {
  it('fails with advice when the daemon is unreachable', () => {
    assert.throws(
      () => preflight(() => ({ status: 1, stdout: '', stderr: 'Cannot connect' })),
      (/** @type {unknown} */ e) =>
        e instanceof DevDepsError &&
        e.message.includes('not running') &&
        e.hint.includes('DEVENV-001'),
    );
  });

  it('warns about too little memory or CPU', () => {
    const w = preflight(() => ok(`${String(2 * 1024 ** 3)} 1`));
    assert.equal(w.length, 2);
    assert.deepEqual(
      preflight(() => ok(`${String(16 * 1024 ** 3)} 8`)),
      [],
    );
  });
});

describe('orchestrateUp (pnpm dev:deps)', () => {
  it('starts the core set, waits healthy, then runs every bootstrap in the required order', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack({ delay: 2 });
      const done = await orchestrateUp(stack.deps(lockFile), { lockFile });
      assert.deepEqual(done, [
        'neo4j-constraints',
        'openbao-transit',
        'minio-buckets',
        'temporal-namespace',
        'keycloak-realm',
      ]);
      assert.deepEqual(
        done,
        BOOTSTRAP_ORDER.map((s) => s.name),
      );
      assert.equal(stack.calls[0], `up -d ${CORE_SERVICES.join(' ')}`);
      const idx = (/** @type {string} */ prefix) =>
        stack.calls.findIndex((c) => c.startsWith(prefix));
      assert.ok(idx('exec -T neo4j') > idx('ps'));
      assert.ok(idx('exec -T neo4j') < idx('up -d minio-init'));
      assert.ok(idx('up -d minio-init') < idx('up -d temporal-bootstrap'));
      assert.ok(idx('up -d temporal-bootstrap') < idx('up -d keycloak'));
      assert.match(stack.hostCalls[0] ?? '', /openbao\/bootstrap\.sh$/);
      assert.equal(existsSync(lockFile), false, 'lock released');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edge case: a bootstrap never runs before its service is healthy; the failure names it', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack({ unhealthy: ['openbao'] });
      await assert.rejects(
        orchestrateUp(stack.deps(lockFile), { lockFile }),
        (/** @type {unknown} */ e) =>
          e instanceof DevDepsError &&
          e.message.includes('unhealthy: openbao') &&
          e.hint === RESET_HINT,
      );
      assert.equal(
        stack.calls.some((c) => c.startsWith('exec')),
        false,
      );
      assert.deepEqual(stack.hostCalls, []);
      assert.equal(existsSync(lockFile), false, 'lock released on failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a one-shot bootstrap job that fails is reported by name', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack({ jobExit: { 'temporal-bootstrap': 1 } });
      const deps = stack.deps(lockFile);
      await assert.rejects(
        orchestrateUp(deps, { lockFile }),
        /temporal-namespace: unhealthy: temporal-bootstrap/,
      );
      assert.equal(stack.calls.includes('up -d keycloak'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run issues the same steps and succeeds', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack();
      await orchestrateUp(stack.deps(lockFile), { lockFile });
      const first = [...stack.calls].filter((c) => !c.startsWith('ps'));
      stack.calls.length = 0;
      await orchestrateUp(stack.deps(lockFile), { lockFile });
      assert.deepEqual(
        stack.calls.filter((c) => !c.startsWith('ps')),
        first,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edge case: killed mid-bootstrap -> re-run converges', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack({ failOnce: ['openbao'] });
      await assert.rejects(orchestrateUp(stack.deps(lockFile), { lockFile }), /openbao-transit/);
      const done = await orchestrateUp(stack.deps(lockFile), { lockFile });
      assert.equal(done.length, BOOTSTRAP_ORDER.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edge case: a Neo4j guard that cannot be verified fails with a reset hint', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack({ failOnce: ['neo4j'] });
      await assert.rejects(
        orchestrateUp(stack.deps(lockFile), { lockFile }),
        (/** @type {unknown} */ e) =>
          e instanceof DevDepsError &&
          e.message.includes('neo4j-constraints') &&
          e.hint.includes('dev:deps:reset --yes'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when Keycloak does not serve the blackwing-dev realm', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      const stack = fakeStack();
      /** @type {string[]} */
      const urls = [];
      const deps = stack.deps(lockFile, {
        env: { BW_DEV_KEYCLOAK_PORT: '28080' },
        waitHttp: (url) => {
          urls.push(url);
          return Promise.reject(new Error('404'));
        },
      });
      await assert.rejects(orchestrateUp(deps, { lockFile }), /realm blackwing-dev/);
      assert.deepEqual(urls, ['http://127.0.0.1:28080/realms/blackwing-dev']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dev:deps:obs adds the obs profile and services to the bring-up', async () => {
    const dir = tmpDir();
    try {
      const lockFile = path.join(dir, 'lock');
      /** @type {string[][]} */
      const raw = [];
      const stack = fakeStack();
      const deps = stack.deps(lockFile);
      const base = deps.compose;
      deps.compose = (args) => {
        raw.push(args);
        return base(args);
      };
      await orchestrateUp(deps, { lockFile, profiles: ['obs'], extraServices: ['grafana'] });
      assert.deepEqual(raw[0]?.slice(0, 4), ['--profile', 'obs', 'up', '-d']);
      assert.equal(raw[0].includes('grafana'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dev:doctor', () => {
  const example =
    'BW_DEV_POSTGRES_PASSWORD=\nBW_DEV_POSTGRES_PORT=15432\nBW_DEV_GOOGLE_CLIENT_ID=\n';
  const healthy = () => {
    /** @type {Record<string, { State: string, Health?: string }>} */
    const m = {};
    for (const s of DOCTOR_SERVICES) m[s] = { State: 'running', Health: 'healthy' };
    for (const s of DOCTOR_ONE_SHOTS) m[s] = { State: 'exited' };
    m['minio-init'] = { State: 'running', Health: 'healthy' };
    return ok(psJson(m));
  };

  /** @param {Partial<Parameters<typeof doctor>[0]>} over */
  function run(over) {
    let text = '';
    const code = doctor({
      example,
      envText:
        'BW_DEV_POSTGRES_PASSWORD=pg-secret-value\nBW_DEV_POSTGRES_PORT=25432\nBW_DEV_GOOGLE_CLIENT_ID=\n',
      ps: healthy,
      env: { BW_DEV_POSTGRES_PORT: '25432', BW_DEV_POSTGRES_PASSWORD: 'pg-secret-value' },
      out: (s) => (text += s),
      err: (s) => (text += s),
      ...over,
    });
    return { code, text };
  }

  it('reports every service healthy and the endpoints, never a secret value', () => {
    const { code, text } = run({});
    assert.equal(code, 0);
    assert.match(text, /dev:doctor: all healthy/);
    assert.match(text, /postgres\s+postgres:\/\/127\.0\.0\.1:25432/);
    assert.match(text, /keycloak\s+http:\/\/127\.0\.0\.1:18080/);
    assert.doesNotMatch(text, /pg-secret-value/);
  });

  it('flags a missing .env key by name', () => {
    const { code, text } = run({ envText: 'BW_DEV_POSTGRES_PORT=15432\n' });
    assert.equal(code, 1);
    assert.match(text, /missing \.env keys: BW_DEV_POSTGRES_PASSWORD/);
  });

  it('flags a missing .env file', () => {
    const { code, text } = run({ envText: undefined });
    assert.equal(code, 1);
    assert.match(text, /missing \.env/);
  });

  it('names unhealthy services and offers the reset', () => {
    const { code, text } = run({
      ps: () => ok(psJson({ postgres: { State: 'running', Health: 'unhealthy' } })),
    });
    assert.equal(code, 1);
    assert.match(text, /not healthy: postgres, valkey/);
    assert.match(text, /dev:deps:reset --yes/);
  });

  it('edge case: Docker not running -> exit 2 with advice', () => {
    const { code, text } = run({ ps: () => ({ status: 1, stdout: '' }), dockerUp: () => false });
    assert.equal(code, 2);
    assert.match(text, /Docker is not reachable[\s\S]*DEVENV-001/);
  });

  it('ignores non-numeric port overrides', () => {
    assert.match(
      endpointLines({ BW_DEV_VALKEY_PORT: 'x;rm' }).join('\n'),
      /redis:\/\/127\.0\.0\.1:16379/,
    );
  });
});

describe('package.json wiring', () => {
  const parsed = /** @type {unknown} */ (
    JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  );
  const pkg = /** @type {{ scripts: Record<string, string> }} */ (parsed);

  it('exposes the DEVENV-010 commands', () => {
    assert.equal(pkg.scripts['dev:deps'], 'node scripts/dev-deps.mjs up');
    assert.equal(pkg.scripts['dev:deps:obs'], 'node scripts/dev-deps.mjs obs');
    assert.equal(pkg.scripts['dev:deps:reset'], 'node scripts/dev-deps.mjs reset');
    assert.equal(pkg.scripts['dev:doctor'], 'node scripts/dev-doctor.mjs');
  });

  it('pnpm dev asserts deps are healthy before starting the apps', () => {
    assert.equal(pkg.scripts.dev, 'node scripts/dev-doctor.mjs && turbo run dev --parallel');
  });

  it('reset drops volumes, then recreates through the same ordered bring-up', () => {
    const src = readFileSync(path.join(ROOT, 'scripts/dev-deps.mjs'), 'utf8');
    const reset = /if \(cmd === 'reset'\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    assert.ok(reset.indexOf("'down', '-v'") > 0);
    assert.ok(reset.indexOf('await orchestrate(envFile)') > reset.indexOf("'down', '-v'"));
  });
});
