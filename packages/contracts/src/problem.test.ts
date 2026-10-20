import { describe, expect, it } from 'vitest';

import { problemSchema } from './problem.js';

const base = {
  type: 'https://errors.blackwing.dev/not_found',
  title: 'Resource not found',
  status: 404,
  code: 'not_found',
  traceId: 'abc123',
};

describe('problemSchema', () => {
  it('accepts a minimal problem and one with field errors and detail', () => {
    expect(problemSchema.safeParse(base).success).toBe(true);
    expect(
      problemSchema.safeParse({
        ...base,
        status: 422,
        detail: 'bad',
        errors: [{ path: 'a.b', message: 'm', code: 'too_small' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a non-URL type, a fractional status and a missing traceId', () => {
    expect(problemSchema.safeParse({ ...base, type: 'nope' }).success).toBe(false);
    expect(problemSchema.safeParse({ ...base, status: 404.5 }).success).toBe(false);
    const rest: Record<string, unknown> = { ...base };
    delete rest.traceId;
    expect(problemSchema.safeParse(rest).success).toBe(false);
  });
});
