// MENTOR-002 (#421): the summary budget defaults to 6000 characters, honours its env key and fails closed.
import { describe, expect, it } from 'vitest';

import { loadConfig } from './env.js';
import { ConfigValidationError } from './errors.js';
import { mentorEnvSchema } from './mentor.js';

const load = (env: Record<string, string>) => loadConfig(mentorEnvSchema, env);

describe('mentor summary budget (MENTOR-002)', () => {
  it('defaults to 6000 characters', () => {
    expect(load({}).MENTOR_SUMMARY_MAX_CHARS).toBe(6000);
  });

  it('reads MENTOR_SUMMARY_MAX_CHARS from env', () => {
    expect(load({ MENTOR_SUMMARY_MAX_CHARS: '8192' }).MENTOR_SUMMARY_MAX_CHARS).toBe(8192);
  });

  it.each(['0', '-1', '1.5', '1e4', 'abc', '01024', '1023', '100001'])(
    'fails closed on %j',
    (raw) => {
      expect(() => load({ MENTOR_SUMMARY_MAX_CHARS: raw })).toThrow(ConfigValidationError);
    },
  );
});
