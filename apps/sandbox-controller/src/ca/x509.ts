import { createHash, randomBytes, webcrypto } from 'node:crypto';

// @peculiar/x509 resolves its DI container at import time and needs the Reflect polyfill first.
import 'reflect-metadata';
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';

/** Per-run CA key: ECDSA P-256 (SANDBOX-008). Small, fast, and accepted by every TLS client we target. */
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface GenerateRunCaInput {
  readonly runId: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export interface GeneratedRunCa {
  readonly certificatePem: string;
  /** PKCS#8 PEM. Returned to the caller only so it can be written to the secret store; never logged. */
  readonly privateKeyPem: string;
  readonly fingerprintSha256: string;
}

/** `sha256:<hex>` of the DER encoding: the form pinned on the run manifest (§8.9). */
export function fingerprintSha256(der: ArrayBuffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(toBytes(der)).digest('hex')}`;
}

const toBytes = (der: ArrayBuffer | Uint8Array): Uint8Array =>
  der instanceof Uint8Array ? der : new Uint8Array(der);

/** Wraps DER bytes in a PEM block with the given label and 64-column lines. */
export function toPem(label: string, der: ArrayBuffer | Uint8Array): string {
  const body = Buffer.from(toBytes(der))
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

const SERIAL_BYTES = 16;
const SERIAL_TOP_BIT_CLEAR = 0x7f;

/** Positive 128-bit serial: the top bit is cleared so DER encodes it without a leading zero octet. */
function randomSerialHex(): string {
  const bytes = randomBytes(SERIAL_BYTES);
  bytes[0] = (bytes[0] ?? 0) & SERIAL_TOP_BIT_CLEAR;
  return bytes.toString('hex');
}

/**
 * Generates a self-signed run CA: `CN=Blackwing Run <runId>`, `basicConstraints CA:TRUE, pathlen:0`,
 * keyCertSign and cRLSign. The window is exactly what the caller passes; the caller is responsible for
 * the backdating and the standing-authorisation cap (see `run-ca.ts`).
 */
export async function generateRunCa(input: GenerateRunCaInput): Promise<GeneratedRunCa> {
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerialHex(),
    name: `CN=Blackwing Run ${input.runId}`,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    certificatePem: certificate.toString('pem'),
    privateKeyPem: toPem('PRIVATE KEY', pkcs8),
    fingerprintSha256: fingerprintSha256(certificate.rawData),
  };
}

/** Parses a PEM certificate and returns the validity window and fingerprint. Throws on malformed input. */
export function describeCertificate(pem: string): {
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly fingerprintSha256: string;
} {
  const cert = new X509Certificate(pem);
  return {
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    fingerprintSha256: fingerprintSha256(cert.rawData),
  };
}
