import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ASSET_ID,
  createScaffoldFixture,
  sha256Hex,
  validManifest,
  type ScaffoldFixture,
} from './fixtures.test-helpers.js';
import { scaffoldHarness, type HarnessLayout } from './scaffold.js';

import type { AddressInfo } from 'node:net';

const run = promisify(execFile);

/** The body the fake egress gateway serves for every order, and the body it serves for `/missing`. */
const ORDER_BODY = '{"ok":true,"order":"42"}';
const MISSING_BODY = '{"error":"not found"}';

/**
 * A fake egress gateway: an HTTP proxy that answers absolute-form requests. The runner must send its traffic here,
 * so `seen` is the proof that no request bypassed the proxy.
 */
interface FakeEgress {
  readonly url: string;
  readonly seen: string[];
  close(): Promise<void>;
}

async function startFakeEgress(): Promise<FakeEgress> {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.url ?? '');
    if (request.url?.endsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(MISSING_BODY);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(ORDER_BODY);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

/**
 * A public, self-signed test certificate standing in for the per-run CA. It has no private key here, and the runner
 * never reaches TLS in these tests, so it only has to load as a trust bundle.
 */
const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUHy6hb+HV5Gdh0U0C5YSXpZl/XaswCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYnctaGFybmVzcy10ZXN0LWNhMCAXDTI2MTAzMTAzMzIzOFoY
DzIxMjYxMDA3MDMzMjM4WjAdMRswGQYDVQQDDBJidy1oYXJuZXNzLXRlc3QtY2Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATgNawP06tqT6Ayc+727A0mH8qsuzyX
qXSLOwU+y/heiA/MVD/eF5R6gUT1k4Pq1FY+MB//iglyznVMBJGtKLvAo1MwUTAd
BgNVHQ4EFgQUzsm9FNNfePeZ83Np1Zl5OcznNgYwHwYDVR0jBBgwFoAUzsm9FNNf
ePeZ83Np1Zl5OcznNgYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiEA1Vp5ZAEKarqIm1JmquW+LazplNf1BnSxM0Rb5wCB3VICICNnierpb4ZHtWep
Gg+nAT0jsKWdPz2KN15DUb9eOh6e
-----END CERTIFICATE-----\n`;

let base: string;
let fixture: ScaffoldFixture;
let egress: FakeEgress;
let caBundle: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-harness-run-'));
  caBundle = join(base, 'run-ca.pem');
  await writeFile(caBundle, TEST_CA_PEM);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  egress = await startFakeEgress();
  fixture = await createScaffoldFixture(await mkdtemp(join(base, 'ws-')), join(base, 'src'));
});

afterEach(async () => {
  await egress.close();
});

/** Runs the scaffolded runner with a given environment and resolves with its exit code and stderr. */
async function runRunner(
  layout: HarnessLayout,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  try {
    await run('python3', [join(layout.root, 'runner')], {
      cwd: layout.root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? '' };
  }
}

const egressEnv = (): Record<string, string> => ({
  HTTP_PROXY: egress.url,
  HTTPS_PROXY: egress.url,
  ALL_PROXY: egress.url,
  SSL_CERT_FILE: caBundle,
});

async function observations(layout: HarnessLayout): Promise<unknown> {
  return JSON.parse(await readFile(join(layout.root, 'observations.json'), 'utf8'));
}

describe('harness runner (EXPLOIT-002)', () => {
  it('runs the positive steps then the negative control through the egress proxy, in order', async () => {
    const manifest = validManifest();
    const layout = await scaffoldHarness(
      { ...manifest, steps: manifest.steps.slice(0, 1) },
      fixture.deps,
    );

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(0);
    expect(await observations(layout)).toEqual([
      {
        bodyBytes: Buffer.byteLength(ORDER_BODY),
        bodySha256: sha256Hex(ORDER_BODY),
        kind: 'http_request',
        outcome: 'response',
        phase: 'positive',
        position: 0,
        ref: 'fetch-order',
        roleKey: 'viewer',
        status: 200,
        truncated: false,
      },
      {
        bodyBytes: Buffer.byteLength(ORDER_BODY),
        bodySha256: sha256Hex(ORDER_BODY),
        kind: 'http_request',
        outcome: 'response',
        phase: 'negative_control',
        position: 0,
        ref: 'fetch-order-benign',
        roleKey: 'owner',
        status: 200,
        truncated: false,
      },
    ]);
    expect(egress.seen).toEqual([
      'http://app.example.test/orders/42',
      'http://app.example.test/orders/42',
    ]);
  });

  it('is deterministic: two runs on the same inputs write byte-identical observations', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    await runRunner(layout, egressEnv());
    const first = await readFile(join(layout.root, 'observations.json'), 'utf8');
    await rm(join(layout.root, 'observations.json'));
    await runRunner(layout, egressEnv());
    const second = await readFile(join(layout.root, 'observations.json'), 'utf8');

    expect(second).toBe(first);
  });

  it('refuses to run with no egress proxy and never opens a direct connection', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const result = await runRunner(layout, { SSL_CERT_FILE: caBundle });

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/no egress proxy/);
    expect(egress.seen).toEqual([]);
    await expect(access(join(layout.root, 'observations.json'))).rejects.toThrow();
  });

  it('refuses to run with an unreadable CA bundle', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    const garbage = join(base, 'garbage.pem');
    await writeFile(garbage, 'not a certificate');

    const result = await runRunner(layout, { ...egressEnv(), SSL_CERT_FILE: garbage });

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/per-run CA bundle is unreadable/);
    expect(egress.seen).toEqual([]);
  });

  it('refuses to run without a per-run CA bundle', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const result = await runRunner(layout, {
      HTTP_PROXY: egress.url,
      HTTPS_PROXY: egress.url,
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/per-run CA bundle/);
    expect(egress.seen).toEqual([]);
  });

  it('stops at an unsupported step kind and exits 2, leaving later steps unrun', async () => {
    const manifest = validManifest();
    const layout = await scaffoldHarness(
      {
        ...manifest,
        steps: [
          { kind: 'tcp_probe', ref: 'probe-port', params: { host: 'app.example.test', port: 443 } },
          ...manifest.steps.slice(0, 1),
        ],
      },
      fixture.deps,
    );

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(2);
    const recorded = (await observations(layout)) as { outcome: string; ref: string }[];
    expect(recorded.map((entry) => [entry.ref, entry.outcome])).toEqual([
      ['probe-port', 'unsupported'],
    ]);
    expect(egress.seen).toEqual([]);
  });

  it('fails closed on an input that changed after scaffolding (sha256 check)', async () => {
    const layout = await scaffoldHarness(validManifest(), fixture.deps);
    await writeFile(join(layout.root, 'inputs/0.bin'), '99\n');

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(5);
    const recorded = (await observations(layout)) as { outcome: string; error: string }[];
    expect(recorded[0]).toMatchObject({
      outcome: 'step_error',
      error: 'input failed its sha256 check',
    });
    expect(egress.seen).toEqual([]);
  });

  it('rejects an input value outside the allowed alphabet and sends no request', async () => {
    await writeFile(fixture.orderIdPath, '../admin\n');
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(5);
    const recorded = (await observations(layout)) as { outcome: string; error: string }[];
    expect(recorded[0]).toMatchObject({
      outcome: 'step_error',
      error: 'input value is outside the allowed input alphabet',
    });
    expect(egress.seen).toEqual([]);
  });

  it('refuses a binary input in a URL template', async () => {
    await writeFile(fixture.orderIdPath, Buffer.from([0xff, 0xfe, 0x00]));
    const layout = await scaffoldHarness(validManifest(), fixture.deps);

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(5);
    const recorded = (await observations(layout)) as { error: string }[];
    expect(recorded[0]?.error).toBe('binary input cannot fill a request template');
    expect(egress.seen).toEqual([]);
  });

  it('records a non-2xx status as an observation rather than a failure', async () => {
    const missing = {
      kind: 'http_request' as const,
      ref: 'fetch-missing',
      params: {
        method: 'GET' as const,
        endpoint: { assetId: ASSET_ID, urlTemplate: 'http://app.example.test/missing' },
        roleKey: 'viewer',
        inputRef: null,
      },
    };
    const layout = await scaffoldHarness(
      { ...validManifest(), steps: [missing], negativeControl: [missing], inputsRef: [] },
      fixture.deps,
    );

    const result = await runRunner(layout, egressEnv());

    expect(result.code).toBe(0);
    const recorded = (await observations(layout)) as { status: number; outcome: string }[];
    expect(recorded[0]).toMatchObject({ outcome: 'response', status: 404 });
  });
});
