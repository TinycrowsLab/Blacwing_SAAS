// DEMO-STORY unit tests: the pure rules of the demo API (no database): roles, origins, kill confirmation,
// the Gate 2 countdown and the ownership proof.
import { describe, expect, it, vi } from 'vitest';

import { DemoRefusal, DemoService, actorHasRole, originsOf, secondsLeft, shortId } from './service.js';

import type { AssetRow, DemoStore } from './store.js';

describe('actorHasRole', () => {
  it('accepts the Keycloak dash form and the seed underscore form', () => {
    const dashed = { id: 'u1', email: 'a@acme.test', name: 'A', roles: ['asset-owner'] };
    const underscored = { id: 'u2', email: 'b@acme.test', name: 'B', roles: ['appsec_engineer'] };
    expect(actorHasRole(dashed, 'asset-owner')).toBe(true);
    expect(actorHasRole(underscored, 'appsec-engineer')).toBe(true);
    expect(actorHasRole(dashed, 'appsec-engineer')).toBe(false);
  });
});

describe('originsOf', () => {
  it('reduces URLs to scheme, host and port and removes duplicates', () => {
    expect(
      originsOf(['https://shop.example.com/app?q=1', 'https://shop.example.com/', 'https://api.example.com:8443/v1']),
    ).toEqual(['https://shop.example.com', 'https://api.example.com:8443']);
  });
});

describe('secondsLeft', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  it('rounds up and never goes below zero', () => {
    expect(secondsLeft(new Date('2026-11-05T10:00:01.200Z'), now)).toBe(2);
    expect(secondsLeft(new Date('2026-11-05T09:59:00Z'), now)).toBe(0);
  });
});

const asset = (token: string | null): AssetRow => ({
  id: 'a1',
  tenant_id: 't1',
  slug: 'x',
  name: 'X',
  base_url: 'https://app.example.com/base',
  ownership_status: 'unverified',
  verification_method: null,
  allowed_origins: ['https://app.example.com'],
  excluded_paths: [],
  verification_token: token,
  verified_by: null,
  verified_at: null,
  verified_by_name: null,
  created_at: new Date(),
});

const owner = { id: 'u1', email: 'o@acme.test', name: 'Owner', roles: ['asset-owner'] };

function serviceWith(row: AssetRow, response: Response | Error) {
  const store = {
    getAsset: vi.fn().mockResolvedValue(row),
    markAssetVerified: vi.fn().mockResolvedValue(true),
  };
  const fetchImpl = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  return { store, service: new DemoService(store as unknown as DemoStore, 't1', fetchImpl) };
}

describe('verifyAsset http_token', () => {
  it('fetches the well-known file on the origin without following redirects and accepts the token', async () => {
    const { store, service } = serviceWith(asset('abc123'), new Response('proof abc123\n'));
    await service.verifyAsset(owner, 'a1', { method: 'http_token' });
    expect(store.markAssetVerified).toHaveBeenCalledWith('t1', 'a1', 'http_token', 'u1');
  });

  it.each([
    ['wrong content', new Response('nope')],
    ['404', new Response('abc123', { status: 404 })],
    ['network error', new Error('down')],
  ])('refuses on %s', async (_name, response) => {
    const { store, service } = serviceWith(asset('abc123'), response);
    await expect(service.verifyAsset(owner, 'a1', { method: 'http_token' })).rejects.toMatchObject({
      response: { code: 'verification_failed' },
    });
    expect(store.markAssetVerified).not.toHaveBeenCalled();
  });

  it('only an asset owner may verify', async () => {
    const { service } = serviceWith(asset('abc123'), new Response('abc123'));
    const engineer = { ...owner, roles: ['appsec-engineer'] };
    await expect(service.verifyAsset(engineer, 'a1', { method: 'owner_attestation' })).rejects.toBeInstanceOf(DemoRefusal);
  });
});

describe('kill', () => {
  const run = { id: '0197a5d0-aaaa-7000-8000-000000000001' };
  const actor = { id: 'u2', email: 'a@acme.test', name: 'A', roles: [] };

  function killService() {
    const store = {
      getRun: vi.fn().mockResolvedValue(run),
      killQueuedRun: vi.fn().mockResolvedValue(null),
      requestKill: vi.fn().mockResolvedValue(new Date('2026-11-05T10:00:00Z')),
      appendEvent: vi.fn(),
    };
    return { store, service: new DemoService(store as unknown as DemoStore, 't1') };
  }

  it('requires the run short id, case-insensitively, and flags a running run for the worker', async () => {
    const { store, service } = killService();
    await expect(service.kill(actor, run.id, 'wrong')).rejects.toMatchObject({
      response: { code: 'kill_confirmation_mismatch' },
    });
    expect(store.requestKill).not.toHaveBeenCalled();
    const result = await service.kill(actor, run.id, shortId(run.id).toUpperCase());
    expect(result.killRequestedAt).toBe('2026-11-05T10:00:00.000Z');
  });
});
