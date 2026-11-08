import { describe, expect, it } from 'vitest';

import { subagents, systemPrompt } from './prompts.js';

import type { HuntRun } from './types.js';

const run: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'Find access-control bugs',
  scope: { allowedOrigins: ['http://127.0.0.1:3082'], excludedPaths: ['/setup.php'] },
  budgetRequests: 300,
  budgetSeconds: 900,
  costCapUsd: 4,
  intrusiveness: 'active_safe',
  testAccounts: [
    { role: 'dvwa_admin', headerName: 'Cookie', headerValue: 'PHPSESSID=secret-session' },
    { role: 'gordonb', headerName: 'Cookie', headerValue: 'PHPSESSID=other-session' },
  ],
  releaseProven: 'hold',
  labOrigins: ['http://127.0.0.1:3082'],
};

const all = (r: HuntRun): string[] => [systemPrompt(r), ...Object.values(subagents(r)).map((a) => a.prompt)];

describe('prompts', () => {
  it('give the test-account roles and the as_role rule to the planner, recon and both specialists', () => {
    for (const prompt of all(run)) {
      expect(prompt).toContain('dvwa_admin, gordonb');
      expect(prompt).toContain('never plan or ask to register accounts; use as_role');
      expect(prompt).toContain('Test as each role at least once');
    }
  });

  it('never carry a credential value', () => {
    for (const prompt of all(run)) expect(prompt).not.toContain('session');
  });

  it('describe the non-blocking Gate 2 flow, the redaction rule and single-delta controls', () => {
    for (const prompt of all(run)) {
      expect(prompt).not.toContain('waits for the decision');
      expect(prompt).toContain('await_decision');
      expect(prompt).toContain('never claim that a value was redacted');
      expect(prompt).toContain('exactly one difference');
    }
  });

  it('without test accounts says so and does not mention roles to use', () => {
    const blackBox = { ...run, testAccounts: [] };
    expect(systemPrompt(blackBox)).toContain('black-box');
    for (const prompt of all(blackBox)) {
      expect(prompt).toContain('No test accounts are provided');
      expect(prompt).not.toContain('signed-in surface');
    }
  });
});
