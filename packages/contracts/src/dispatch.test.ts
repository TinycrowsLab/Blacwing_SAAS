import { describe, expect, it } from 'vitest';

import { dispatchSubtaskSchema, subtaskBriefSchema } from './dispatch.js';

const ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const brief = {
  targets: ['https://app.example.com/graphql'],
  class: 'active_safe',
  oracle: { type: 'status_diff', params: {} },
  negativeControl: { type: 'status_diff', params: {} },
  budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
  standardRefs: { wstg: ['WSTG-APIT-01'], cwe: ['CWE-89'], owasp: ['A03'] },
};
const request = { subtaskId: ID, testCaseId: ID, persona: 'web-api-specialist', brief };

describe('dispatchSubtaskSchema', () => {
  it('accepts a complete request', () => {
    expect(dispatchSubtaskSchema.safeParse(request).success).toBe(true);
  });

  it.each(['targets', 'class', 'oracle', 'negativeControl', 'budget', 'standardRefs'])(
    'rejects a brief without %s',
    (field) => {
      const rest = Object.fromEntries(Object.entries(brief).filter(([key]) => key !== field));
      expect(subtaskBriefSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('rejects a destructive class, empty targets and empty standard refs', () => {
    expect(subtaskBriefSchema.safeParse({ ...brief, class: 'destructive' }).success).toBe(false);
    expect(subtaskBriefSchema.safeParse({ ...brief, targets: [] }).success).toBe(false);
    expect(
      subtaskBriefSchema.safeParse({ ...brief, standardRefs: { wstg: [], cwe: [], owasp: [] } })
        .success,
    ).toBe(false);
  });

  it('rejects unknown keys and a non-uuid subtask id', () => {
    expect(dispatchSubtaskSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    expect(dispatchSubtaskSchema.safeParse({ ...request, subtaskId: 'nope' }).success).toBe(false);
  });
});
