import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { middleware } from './middleware';

const request = (path: string, cookie?: string): NextRequest =>
  new NextRequest(
    `http://localhost:3000${path}`,
    cookie === undefined ? {} : { headers: { cookie } },
  );

const PORTAL = '__Host-bw_soc_portal=sealed-value';
const SESSION = '__Host-bw_session=session-id';

describe('scoped SOC portal session routing', () => {
  it.each(['/settings/org', '/assets', '/runs/123', '/login', '/api/auth/session', '/'])(
    'answers 403 to a portal-only visitor on %s',
    (path) => {
      const res = middleware(request(path, PORTAL));
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it.each([
    '/portal',
    '/portal/expired',
    '/link/abc.def.ghi',
    '/soc/kill/abc',
    '/_next/static/x.js',
  ])('lets a portal-only visitor reach the SOC route %s', (path) => {
    expect(middleware(request(path, PORTAL)).status).toBe(200);
  });

  it('does not treat a path that merely starts with a SOC name as a SOC route', () => {
    expect(middleware(request('/portalx', PORTAL)).status).toBe(403);
    expect(middleware(request('/solo', PORTAL)).status).toBe(403);
  });

  it('leaves every route alone for a visitor with no portal cookie', () => {
    expect(middleware(request('/settings/org')).status).toBe(200);
  });

  it('leaves console routes alone when a console session is also present', () => {
    expect(middleware(request('/settings/org', `${PORTAL}; ${SESSION}`)).status).toBe(200);
  });
});
