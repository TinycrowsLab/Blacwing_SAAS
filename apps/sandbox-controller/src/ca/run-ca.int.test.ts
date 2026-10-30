// Per-run CA against a real OpenBao dev server (SANDBOX-008): the key lives only in the secret store, the
// AppRole can reach nothing else, revoke makes the key 404, and a process started with the injected trust
// env verifies a stub gateway whose certificate the run CA signed. Needs Docker (Testcontainers); run with
// `pnpm --filter @blackwing/sandbox-controller test:int`.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import 'reflect-metadata';
import {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sandboxSpecSchema } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { createOpenBaoClient, type OpenBaoClient } from '@blackwing/secrets';
import { type OpenBaoHandle, withOpenBao } from '@blackwing/testing/containers';

import { createControllerMetrics } from '../metrics.js';
import { createInMemoryEgressCaRegistry } from './egress-registry.js';
import { createRunCaProvisioner, type RunCaAuditEvent } from './run-ca.js';
import { caTrustFragment } from './trust.js';
import { describeCertificate, toPem } from './x509.js';

import type { AddressInfo } from 'node:net';

const TENANT = '01930000-0000-7000-8000-00000000000a';
const RUN = '01930000-0000-7000-8000-0000000000a1';
const SANDBOX = '01930000-0000-7000-8000-0000000000b1';
const SESSION = '01930000-0000-7000-8000-0000000000c1';
const RUN_END = new Date(Date.now() + 60 * 60_000).toISOString();
const SA_EXPIRY = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const RUN_BASE = `secret/data/tenants/${TENANT}/runs/${RUN}/run-ca`;

let bao: OpenBaoHandle | undefined;
const handle = (): OpenBaoHandle => {
  if (bao === undefined) throw new Error('withOpenBao did not start');
  return bao;
};

/** Raw root-token call: returns the status and parsed body, so 404s are asserted rather than thrown. */
async function rootCall(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${handle().addr}/v1/${path}`, {
    method,
    headers: { 'x-vault-token': handle().rootToken },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

const policy = (name: string): string =>
  readFileSync(
    new URL(`../../../../infra/compose/openbao/policies/${name}.hcl`, import.meta.url),
    'utf8',
  );

async function roleClient(role: string): Promise<OpenBaoClient> {
  await rootCall('PUT', `sys/policies/acl/${role}`);
  await fetch(`${handle().addr}/v1/sys/policies/acl/${role}`, {
    method: 'PUT',
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    body: JSON.stringify({ policy: policy(role) }),
  });
  await fetch(`${handle().addr}/v1/auth/approle/role/${role}`, {
    method: 'POST',
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    body: JSON.stringify({ token_policies: [role] }),
  });
  const roleIdRes = (await rootCall('GET', `auth/approle/role/${role}/role-id`)).body as {
    data: { role_id: string };
  };
  const secretRes = await fetch(`${handle().addr}/v1/auth/approle/role/${role}/secret-id`, {
    method: 'POST',
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    body: '{}',
  });
  const secretId = ((await secretRes.json()) as { data: { secret_id: string } }).data.secret_id;
  return createOpenBaoClient({
    addr: handle().addr,
    roleId: roleIdRes.data.role_id,
    secretId,
  });
}

const pemBody = (pem: string): Buffer =>
  Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');

/** A leaf for the stub gateway, signed by the run CA: the only place the CA key is used, in the test. */
async function signGatewayLeaf(
  caCertPem: string,
  caKeyPem: string,
): Promise<{ cert: string; key: string }> {
  const caCert = new X509Certificate(caCertPem);
  const caKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pemBody(caKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const leaf = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const cert = await X509CertificateGenerator.create({
    serialNumber: '0a0b0c',
    subject: 'CN=stub-egress-gateway',
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 30 * 60_000),
    publicKey: leaf.publicKey,
    signingKey: caKey,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const key = toPem(
    'PRIVATE KEY',
    await globalThis.crypto.subtle.exportKey('pkcs8', leaf.privateKey),
  );
  return { cert: cert.toString('pem'), key };
}

/** Runs a fresh Node process with exactly `env` and fetches the stub gateway over HTTPS. */
function fetchFromGateway(
  port: number,
  env: Record<string, string>,
): Promise<{ ok: boolean; body: string; stderr: string }> {
  const script = `require('https').get('https://127.0.0.1:${String(port)}/', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { process.stdout.write(b); }); }).on('error', (e) => { process.stderr.write(String(e.code ?? e.message)); process.exitCode = 1; });`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', script],
      { env, timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, body: stdout, stderr });
      },
    );
  });
}

let gateway: Server | undefined;
let gatewayPort = 0;
let trustDir = '';
let appClient: OpenBaoClient;
let runCaPem = '';
let runCaRef: Awaited<ReturnType<ReturnType<typeof createRunCaProvisioner>['issueRunCa']>>;
const egress = createInMemoryEgressCaRegistry();
const audit: RunCaAuditEvent[] = [];
const metrics = createControllerMetrics('0.0.0', 'test');
let provisioner: ReturnType<typeof createRunCaProvisioner>;

beforeAll(async () => {
  bao = await withOpenBao();
  await fetch(`${handle().addr}/v1/sys/auth/approle`, {
    method: 'POST',
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'approle' }),
  });
  appClient = await roleClient('bw-run-ca');
  provisioner = createRunCaProvisioner({
    openbao: appClient,
    egress,
    audit: {
      emit: (event) => {
        audit.push(event);
        return Promise.resolve();
      },
    },
    metrics,
  });
  trustDir = await mkdtemp(join(tmpdir(), 'bw-run-ca-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (gateway === undefined) {
      resolve();
      return;
    }
    gateway.close(() => {
      resolve();
    });
  });
  await bao?.stop();
});

describe('run CA against OpenBao', () => {
  it('issues a run CA whose key is stored only in OpenBao, with the public certificate as the reference', async () => {
    runCaRef = await provisioner.issueRunCa({
      tenantId: TENANT,
      runId: RUN,
      runWindowEndsAt: RUN_END,
      standingAuthorisationExpiresAt: SA_EXPIRY,
    });

    const keyRecord = (await rootCall('GET', `${RUN_BASE}/key`)).body as {
      data: { data: { pem: string } };
    };
    expect(keyRecord.data.data.pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(runCaRef.keyRef).toBe(`openbao://${RUN_BASE}/key`);

    const certRecord = (await rootCall('GET', `${RUN_BASE}/cert`)).body as {
      data: { data: { pem: string } };
    };
    runCaPem = certRecord.data.data.pem;
    expect(runCaPem).toBe(runCaRef.certificatePem);
    const window = describeCertificate(runCaPem);
    expect(window.notAfter.getTime()).toBeLessThanOrEqual(Date.parse(SA_EXPIRY));
    expect(window.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the private key out of the sandbox spec, the audit events and the mounted bundle', async () => {
    const keyPem = (
      (await rootCall('GET', `${RUN_BASE}/key`)).body as { data: { data: { pem: string } } }
    ).data.data.pem;
    const fragment = caTrustFragment(runCaRef.caBundleRef);
    const spec = {
      sandboxId: SANDBOX,
      runId: RUN,
      tenantId: TENANT,
      sessionId: SESSION,
      persona: 'code-specialist',
      imageDigest: `registry.example/sandbox@sha256:${'b'.repeat(64)}`,
      runtimeClass: 'gvisor',
      network: { runId: RUN, networkId: 'net-run' },
      resources: { cpu: 1, memoryMiB: 2048, pids: 512 },
      env: { ...fragment.env },
      mounts: [...fragment.mounts],
      ttlSeconds: 3600,
      caBundleRef: runCaRef.caBundleRef,
    };
    expect(sandboxSpecSchema.safeParse(spec).success).toBe(true);
    expect(JSON.stringify(spec)).not.toContain(keyPem);
    expect(JSON.stringify(spec)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(audit)).not.toContain('PRIVATE KEY');
    expect(audit.map((e) => e.type)).toEqual(['run_ca.issued']);
  });

  it('a process started with the injected trust env accepts a gateway certificate signed by the run CA', async () => {
    // The sandbox reads the certificate reference through the controller's own role (the public cert only).
    const certFromStore = (
      await appClient.request('GET', runCaRef.caBundleRef.slice('openbao://'.length))
    ).data as {
      data: { pem: string };
    };
    const mounted = join(trustDir, 'ca.pem');
    await writeFile(mounted, certFromStore.data.pem, { mode: 0o444 });
    expect(readFileSync(mounted, 'utf8')).not.toContain('PRIVATE KEY');

    const caKey = (
      (await appClient.request('GET', `${RUN_BASE}/key`)).data as { data: { pem: string } }
    ).data.pem;
    const leaf = await signGatewayLeaf(runCaPem, caKey);
    const server = createServer({ key: leaf.key, cert: leaf.cert }, (_req, res) => {
      res.end('gateway-ok');
    });
    gateway = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    gatewayPort = (server.address() as AddressInfo).port;

    // Only the trust env of the sandbox spec (pointing at the mounted cert) is passed to the child process.
    const trustEnv = Object.fromEntries(
      Object.entries(caTrustFragment(runCaRef.caBundleRef).env).map(([key]) => [key, mounted]),
    );
    const trusted = await fetchFromGateway(gatewayPort, trustEnv);
    expect(trusted).toEqual({ ok: true, body: 'gateway-ok', stderr: '' });

    const untrusted = await fetchFromGateway(gatewayPort, {});
    expect(untrusted.ok).toBe(false);
    expect(untrusted.stderr).not.toBe('');
  });

  it('the controller role can reach run CA paths only: nothing else in the secret store', async () => {
    await expect(
      appClient.request('GET', 'secret/data/platform/kek-state/acme'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(appClient.request('GET', 'transit/keys/tenant-acme')).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('revoke deletes the key so a later fetch 404s, and withdraws the run from the egress gateway', async () => {
    expect(egress.lookup({ tenantId: TENANT, runId: RUN })).toBeDefined();
    await provisioner.revokeRunCa({ tenantId: TENANT, runId: RUN });

    expect((await rootCall('GET', `${RUN_BASE}/key`)).status).toBe(404);
    expect((await rootCall('GET', `${RUN_BASE}/cert`)).status).toBe(404);
    expect(egress.lookup({ tenantId: TENANT, runId: RUN })).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({
      type: 'run_ca.revoked',
      fingerprintSha256: runCaRef.fingerprintSha256,
    });
  });
});
