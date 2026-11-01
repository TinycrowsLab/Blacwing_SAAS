import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import {
  openSocPortalLink,
  type SocPortalLinkCounters,
  type SocPortalLinkDeps,
} from './link-open.js';
import { openPortalSession } from './session.js';
import {
  ASSET_ID,
  linkClaims,
  NOW_SECONDS,
  OTHER_ASSET_ID,
  portalConfig,
  signLink,
  newKeyPair,
} from './test-helpers.js';

const NOW_MS = NOW_SECONDS * 1000;

function harness(overrides: Partial<SocPortalLinkDeps> = {}) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString('utf8'));
      done();
    },
  });
  const config = portalConfig();
  const counters: SocPortalLinkCounters = { opened: vi.fn(), rejected: vi.fn() };
  const audit = vi.fn();
  const deps: SocPortalLinkDeps = {
    config,
    now: () => NOW_MS,
    audit,
    logger: createLogger('test-soc-portal', { destination }),
    counters,
    ...overrides,
  };
  return { deps, config, counters, audit, lines };
}

const token = (payload: unknown = linkClaims()): string => signLink(payload);

describe('openSocPortalLink', () => {
  it('redirects a valid link to the portal with a scoped, no-referrer, uncached answer', () => {
    const { deps, counters } = harness();
    const res = openSocPortalLink(token(), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/portal');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(counters.opened).toHaveBeenCalledOnce();
    expect(counters.rejected).not.toHaveBeenCalled();
  });

  it('sets the portal cookie, and that cookie opens to the same claims on the next request', () => {
    const { deps, config } = harness();
    const res = openSocPortalLink(token(), deps);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const value = /^__Host-bw_soc_portal=([^;]+);/.exec(setCookie)?.[1];
    expect(value).toBeDefined();
    expect(openPortalSession(config.sessionKey, value, NOW_SECONDS)).toEqual(linkClaims());
  });

  it('audits the open as soc.portal.opened with ids and counts only', () => {
    const { deps, audit } = harness();
    openSocPortalLink(token(linkClaims({ assetIds: [ASSET_ID, OTHER_ASSET_ID] })), deps);
    expect(audit).toHaveBeenCalledExactlyOnceWith({
      action: 'soc.portal.opened',
      outcome: 'success',
      tenantId: linkClaims().tenantId,
      linkId: linkClaims().jti,
      assetCount: 2,
      occurredAt: new Date(NOW_MS).toISOString(),
    });
  });

  it('never echoes the token in the response or in the log lines', () => {
    const { deps, lines } = harness();
    const raw = token();
    const res = openSocPortalLink(raw, deps);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(raw);
    expect(lines.join('')).not.toContain(raw);
  });

  it.each([
    ['a tampered token', `${token().slice(0, -4)}AAAA`],
    ['garbage', 'not-a-token'],
    ['a link signed by another key', signLink(linkClaims(), newKeyPair())],
  ])('sends %s to the expired page, sets no cookie and audits nothing', (_label, bad) => {
    const { deps, counters, audit } = harness();
    const res = openSocPortalLink(bad, deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/portal/expired');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect(counters.rejected).toHaveBeenCalledWith('invalid');
    expect(counters.opened).not.toHaveBeenCalled();
  });

  it('refuses an expired link with the expired reason, and the same page', () => {
    const { deps, counters } = harness();
    const res = openSocPortalLink(token(linkClaims({ exp: NOW_SECONDS - 3600 })), deps);
    expect(res.headers.get('location')).toBe('/portal/expired');
    expect(counters.rejected).toHaveBeenCalledWith('expired');
  });

  it('refuses every link, with no cookie, while the portal is disabled', () => {
    const { deps, counters, audit } = harness({ config: undefined });
    const res = openSocPortalLink(token(), deps);
    expect(res.headers.get('location')).toBe('/portal/expired');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(counters.rejected).toHaveBeenCalledWith('disabled');
    expect(audit).not.toHaveBeenCalled();
  });
});
