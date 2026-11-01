import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadSocPortalConfig } from './config.js';
import { KID, newKeyPair, SESSION_SECRET } from './test-helpers.js';

const pem = (keys = newKeyPair()): string =>
  keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('loadSocPortalConfig', () => {
  it('is disabled (undefined) when none of its variables are set', () => {
    expect(loadSocPortalConfig({})).toBeUndefined();
  });

  it('loads the key id, the Ed25519 public key and the sealing key when all are set', () => {
    const config = loadSocPortalConfig({
      BW_SOC_LINK_KEY_ID: KID,
      BW_SOC_LINK_PUBLIC_KEY: pem(),
      BW_SOC_PORTAL_SESSION_SECRET: SESSION_SECRET,
    });
    expect(config?.keyId).toBe(KID);
    expect(config?.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(config?.sessionKey.length).toBe(32);
  });

  it('fails fast when the variables are only partly set', () => {
    expect(() => loadSocPortalConfig({ BW_SOC_LINK_KEY_ID: KID })).toThrow();
    expect(() =>
      loadSocPortalConfig({ BW_SOC_LINK_KEY_ID: KID, BW_SOC_LINK_PUBLIC_KEY: pem() }),
    ).toThrow();
  });

  it('refuses a sealing secret shorter than 32 characters', () => {
    expect(() =>
      loadSocPortalConfig({
        BW_SOC_LINK_KEY_ID: KID,
        BW_SOC_LINK_PUBLIC_KEY: pem(),
        BW_SOC_PORTAL_SESSION_SECRET: 'too-short',
      }),
    ).toThrow();
  });

  it('refuses a public key that is not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() =>
      loadSocPortalConfig({
        BW_SOC_LINK_KEY_ID: KID,
        BW_SOC_LINK_PUBLIC_KEY: rsa.export({ type: 'spki', format: 'pem' }).toString(),
        BW_SOC_PORTAL_SESSION_SECRET: SESSION_SECRET,
      }),
    ).toThrow('Ed25519');
  });

  it('refuses a public key that is not PEM at all, without echoing it', () => {
    let message = '';
    try {
      loadSocPortalConfig({
        BW_SOC_LINK_KEY_ID: KID,
        BW_SOC_LINK_PUBLIC_KEY: 'not-a-key-at-all',
        BW_SOC_PORTAL_SESSION_SECRET: SESSION_SECRET,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('not-a-key-at-all');
  });
});
