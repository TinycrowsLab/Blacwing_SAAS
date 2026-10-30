import { describe, expect, it, vi } from 'vitest';

import { ASSET_LOGIN_SECRET_PURPOSE, createSecretsCredentialVault } from './credential-vault.js';

import type { Envelope } from '@blackwing/secrets';

const TENANT = '0198f0a0-0000-7000-8000-0000000000aa';
const SECRET = '0198f0a0-0000-7000-8000-0000000000bb';
const ENVELOPE: Envelope = {
  v: 1,
  alg: 'AES-256-GCM',
  kekKey: 'tenant-x',
  kekVersion: 1,
  wrappedDek: 'vault:v1:x',
  iv: 'AAAA',
  tag: 'AAAA',
  ct: 'AAAA',
  aadHash: 'aa'.repeat(32),
};

describe('createSecretsCredentialVault', () => {
  it('seals under the tenant, the secret id and the asset-login purpose, and returns only the envelope', async () => {
    const encryptSecret = vi.fn(() => Promise.resolve(ENVELOPE));
    const vault = createSecretsCredentialVault({
      crypto: { encryptSecret },
      rotation: { rotateSecret: vi.fn() },
    });
    await expect(
      vault.seal({ tenantId: TENANT, secretId: SECRET, plaintext: '{"password":"p"}' }),
    ).resolves.toBe(ENVELOPE);
    expect(encryptSecret).toHaveBeenCalledWith({
      tenantId: TENANT,
      plaintext: '{"password":"p"}',
      context: { secretId: SECRET, purpose: ASSET_LOGIN_SECRET_PURPOSE },
    });
  });

  it('rotates through the rotation service and reports the version it now serves', async () => {
    const rotateSecret = vi.fn(() =>
      Promise.resolve({ version: 3, previousVersion: 2, retiredAt: new Date() }),
    );
    const vault = createSecretsCredentialVault({
      crypto: { encryptSecret: vi.fn() },
      rotation: { rotateSecret },
    });
    await expect(
      vault.rotate({ tenantId: TENANT, secretId: SECRET, plaintext: 'next' }),
    ).resolves.toBe(3);
    expect(rotateSecret).toHaveBeenCalledWith({
      tenantId: TENANT,
      secretId: SECRET,
      plaintext: 'next',
    });
  });

  it('lets a Secrets Service failure reject, so the caller refuses the write', async () => {
    const vault = createSecretsCredentialVault({
      crypto: {
        encryptSecret: () => Promise.reject(new Error('kek unavailable')),
      },
      rotation: { rotateSecret: vi.fn() },
    });
    await expect(
      vault.seal({ tenantId: TENANT, secretId: SECRET, plaintext: 'p' }),
    ).rejects.toThrow('kek unavailable');
  });
});
