import { describe, expect, it } from 'vitest';

import { hasWorkLeft, resumeCaseMap, untriedOf } from './resume.js';

import type { ResumeState } from './types.js';

const coverage = (cases: unknown[]): unknown => ({ cases, endReason: 'model_error' });

describe('resumeCaseMap', () => {
  it('rebuilds the test-case map from a coverage.summary, preserving outcome', () => {
    const map = resumeCaseMap(
      coverage([
        {
          id: 'c1',
          title: 'SQLi on /login',
          agent: 'web-api-specialist',
          status: 'executed',
          requests: 4,
          candidates: 1,
        },
        {
          id: 'c2',
          title: 'IDOR on /api/users',
          agent: 'authz-specialist',
          status: 'not_run',
          requests: 0,
          candidates: 0,
        },
      ]),
    );
    expect(map.size).toBe(2);
    expect(map.get('c1')?.title).toBe('SQLi on /login');
    expect(map.get('c1')?.requests).toBe(4);
    expect(map.get('c2')?.agent).toBe('authz-specialist');
    // One case still needs a run; the executed one does not.
    expect(untriedOf(map.values())).toBe(1);
  });

  it('drops the runner gap rows (login-*) that carry no re-runnable case', () => {
    const map = resumeCaseMap(
      coverage([
        {
          id: 'login-wall',
          title: 'Pages behind a login',
          status: 'skipped',
          requests: 0,
          candidates: 0,
        },
        {
          id: 'login-failed-admin',
          title: 'Pages behind the admin sign-in',
          status: 'skipped',
          requests: 0,
          candidates: 0,
        },
        { id: 'c9', title: 'Open redirect', status: 'not_run', requests: 0, candidates: 0 },
      ]),
    );
    expect([...map.keys()]).toEqual(['c9']);
  });

  it('does not count a blocked case as needing a run (a denied Gate 2 is not re-asked on resume)', () => {
    const map = resumeCaseMap(
      coverage([{ id: 'c3', title: 'CSRF', status: 'blocked', requests: 0, candidates: 0 }]),
    );
    expect(untriedOf(map.values())).toBe(0);
  });

  it('returns an empty map for malformed or missing data', () => {
    expect(resumeCaseMap(null).size).toBe(0);
    expect(resumeCaseMap({ cases: 'nope' }).size).toBe(0);
    expect(resumeCaseMap({}).size).toBe(0);
  });

  it('skips rows with no id but keeps the rest', () => {
    const map = resumeCaseMap(
      coverage([{ title: 'no id' }, { id: 'ok', title: 'has id', status: 'not_run' }]),
    );
    expect([...map.keys()]).toEqual(['ok']);
  });
});

describe('hasWorkLeft', () => {
  const state = (cases: Parameters<typeof resumeCaseMap>[0]): ResumeState => ({
    cases: resumeCaseMap(cases),
    findings: 0,
    requestsUsed: 10,
    costUsd: 1,
  });

  it('is false for a null resume (a fresh run)', () => {
    expect(hasWorkLeft(null)).toBe(false);
  });

  it('is false when every case already ran', () => {
    expect(
      hasWorkLeft(
        state(coverage([{ id: 'c1', title: 'x', status: 'executed', requests: 2, candidates: 0 }])),
      ),
    ).toBe(false);
  });

  it('is true when a case is still untried', () => {
    expect(
      hasWorkLeft(
        state(coverage([{ id: 'c1', title: 'x', status: 'not_run', requests: 0, candidates: 0 }])),
      ),
    ).toBe(true);
  });
});
