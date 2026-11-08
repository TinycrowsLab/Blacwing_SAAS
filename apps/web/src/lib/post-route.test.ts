import { describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getViewer: vi.fn() }));

const { crossSite, refuseMutation } = await import('./post-route');

const req = (headers: Record<string, string>): Request =>
  new Request('http://127.0.0.1:3000/api/gate2/x/decision', { method: 'POST', headers: { host: '127.0.0.1:3000', ...headers } });

describe('mutation guard for /api routes', () => {
  it('lets the console’s own pages through', () => {
    expect(crossSite(req({ 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3000' }))).toBe(false);
    expect(refuseMutation(req({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }), { json: true })).toBeNull();
  });

  it('refuses another site, a sibling localhost port included (the target under test)', async () => {
    const forged = req({ 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:3001', 'content-type': 'application/json' });
    expect(crossSite(forged)).toBe(true);
    const refused = refuseMutation(forged, { json: true });
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ code: 'cross_site', message: 'This only works from Blackwing itself.' });
    // Without Sec-Fetch-Site the Origin still has to match the Host.
    expect(crossSite(req({ origin: 'http://127.0.0.1:3001' }))).toBe(true);
    expect(crossSite(req({ origin: 'not a url' }))).toBe(true);
  });

  it('refuses a form post (no JSON) where the route takes JSON only', () => {
    const form = req({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' });
    expect(refuseMutation(form, { json: true })?.status).toBe(415);
    expect(refuseMutation(req({ 'sec-fetch-site': 'same-origin' }), { json: true })?.status).toBe(415);
    // pause and resume carry no body: the cross-site check alone.
    expect(refuseMutation(form)).toBeNull();
  });
});
