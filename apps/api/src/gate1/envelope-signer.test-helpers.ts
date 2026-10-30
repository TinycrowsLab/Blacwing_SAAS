import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

import type { Gate1EnvelopeSigner } from './ports.js';
import type { EnvelopeSigningKey, JwsKeyResolver } from '@blackwing/crypto';

/**
 * An in-process stand-in for the OpenBao Transit signing key (#399). The private key stays inside the fake, as it
 * does in OpenBao: callers only get signatures, and `resolver` is the verifier's view of the public key.
 */
export class FakeEnvelopeSigner implements Gate1EnvelopeSigner {
  readonly kid = 'bw-sa-signing:v1';
  private readonly privateKey = generateKeyPairSync('ed25519').privateKey;
  /** Set to make every key request fail like a sealed or unreachable OpenBao. */
  down = false;
  /** How many times a signing key was requested. */
  keyRequests = 0;

  envelopeSigningKey(): Promise<EnvelopeSigningKey> {
    this.keyRequests += 1;
    if (this.down) return Promise.reject(new Error('sealed'));
    return Promise.resolve({
      kid: this.kid,
      sign: (input) =>
        Promise.resolve(new Uint8Array(sign(null, Buffer.from(input), this.privateKey))),
    });
  }

  resolver: JwsKeyResolver = (kid) =>
    kid === this.kid ? createPublicKey(this.privateKey) : undefined;
}
