import 'reflect-metadata';

import { X509Certificate } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';

import { describeCertificate, fingerprintSha256, generateRunCa, toPem } from './x509.js';

const RUN = '01930000-0000-7000-8000-0000000000a1';
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const NOT_BEFORE = new Date('2026-10-30T09:59:00.000Z');
const NOT_AFTER = new Date('2026-10-30T12:00:00.000Z');

describe('generateRunCa', () => {
  it('issues an ECDSA P-256 CA with CA:TRUE, pathlen 0, the run CN and the requested window', async () => {
    const ca = await generateRunCa({ runId: RUN, notBefore: NOT_BEFORE, notAfter: NOT_AFTER });
    const cert = new X509Certificate(ca.certificatePem);

    expect(cert.subject).toBe(`CN=Blackwing Run ${RUN}`);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.notBefore.getTime()).toBe(NOT_BEFORE.getTime());
    expect(cert.notAfter.getTime()).toBe(NOT_AFTER.getTime());
    expect(cert.publicKey.algorithm).toMatchObject({ name: 'ECDSA' });

    const basic = cert.extensions.find((extension) => extension.type === BASIC_CONSTRAINTS_OID);
    expect(basic?.critical).toBe(true);
    // BasicConstraints: SEQUENCE { BOOLEAN TRUE, INTEGER 0 } is the only encoding with CA:TRUE and pathlen 0.
    expect(basic === undefined ? '' : Buffer.from(basic.value).toString('hex')).toBe(
      '30060101ff020100',
    );
  });

  it('returns a PKCS#8 private key PEM that is never the certificate, and a sha256 fingerprint of the DER', async () => {
    const ca = await generateRunCa({ runId: RUN, notBefore: NOT_BEFORE, notAfter: NOT_AFTER });
    expect(ca.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect(ca.certificatePem).not.toContain('PRIVATE KEY');
    expect(ca.fingerprintSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(describeCertificate(ca.certificatePem).fingerprintSha256).toBe(ca.fingerprintSha256);
  });

  it('gives each run CA a fresh key and serial', async () => {
    const a = await generateRunCa({ runId: RUN, notBefore: NOT_BEFORE, notAfter: NOT_AFTER });
    const b = await generateRunCa({ runId: RUN, notBefore: NOT_BEFORE, notAfter: NOT_AFTER });
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
    expect(new X509Certificate(a.certificatePem).serialNumber).not.toBe(
      new X509Certificate(b.certificatePem).serialNumber,
    );
  });
});

describe('fingerprintSha256 and toPem', () => {
  it('hashes DER bytes and wraps base64 in 64-column PEM blocks', () => {
    expect(fingerprintSha256(new Uint8Array([]))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const pem = toPem('TEST', new Uint8Array(100).fill(1));
    const lines = pem.trim().split('\n');
    expect(lines[0]).toBe('-----BEGIN TEST-----');
    expect(lines[lines.length - 1]).toBe('-----END TEST-----');
    expect(lines.slice(1, -1).every((line) => line.length <= 64)).toBe(true);
  });

  it('describeCertificate rejects malformed PEM', () => {
    expect(() => describeCertificate('not a certificate')).toThrow();
  });
});
