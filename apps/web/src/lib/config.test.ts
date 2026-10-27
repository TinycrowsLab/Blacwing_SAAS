import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_GRAPHQL_URL,
  DEFAULT_RUN_POLL_MS,
  getPublicConfig,
  getRunPollMs,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getPublicConfig', () => {
  it('defaults to /v1 and /graphql', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_GRAPHQL_URL', '  ');
    expect(getPublicConfig()).toEqual({ apiBaseUrl: '/v1', graphqlUrl: '/graphql' });
    expect(DEFAULT_API_BASE_URL).toBe('/v1');
    expect(DEFAULT_GRAPHQL_URL).toBe('/graphql');
  });

  it('honours the configured keys', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '/api/v2');
    vi.stubEnv('NEXT_PUBLIC_GRAPHQL_URL', '/gql');
    expect(getPublicConfig()).toEqual({ apiBaseUrl: '/api/v2', graphqlUrl: '/gql' });
  });
});

describe('getRunPollMs', () => {
  it('defaults to 15000 and honours a positive integer only', () => {
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '');
    expect(getRunPollMs()).toBe(DEFAULT_RUN_POLL_MS);
    for (const bad of ['abc', '0', '-5', '1.5']) {
      vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', bad);
      expect(getRunPollMs()).toBe(15_000);
    }
    vi.stubEnv('NEXT_PUBLIC_RUN_POLL_MS', '2000');
    expect(getRunPollMs()).toBe(2000);
  });
});
