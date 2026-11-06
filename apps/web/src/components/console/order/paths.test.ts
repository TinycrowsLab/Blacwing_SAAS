import { describe, expect, it } from 'vitest';

import { readPathList } from './plan-editors';

const ORIGIN = 'http://127.0.0.1:3001';

describe('paths to avoid (spec §10.2)', () => {
  it('turns a pasted list into prefix paths and names what it left out', () => {
    const r = readPathList('admin, /api/Users/** http://127.0.0.1:3001/ftp/ http://evil.example/x /admin/', ORIGIN, []);
    expect(r.paths).toEqual(['/admin', '/api/Users', '/ftp']);
    expect(r.left).toEqual({ token: 'http://evil.example/x', why: "that's on another site, so it's already out of scope" });
  });

  it('refuses a path with a space instead of splitting it in two', () => {
    const r = readPathList('/has space, /billing', ORIGIN, []);
    expect(r.paths).toEqual(['/billing']);
    expect(r.left?.token).toBe('/has space');
  });

  it('takes back a path typed just before the rest of it', () => {
    const r = readPathList('space ', ORIGIN, ['/admin', '/has'], '/has');
    expect(r.paths).toEqual(['/admin']);
    expect(r.left?.token).toBe('/has space');
  });

  it('keeps bare words after a comma as their own paths', () => {
    expect(readPathList('admin, billing', ORIGIN, []).paths).toEqual(['/admin', '/billing']);
  });
});
