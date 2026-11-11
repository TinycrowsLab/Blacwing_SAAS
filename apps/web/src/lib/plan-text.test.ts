import { describe, expect, it } from 'vitest';

import { decisionTitle, objectiveConflicts, objectivePhrase, planSegments, planText, resultsHeadline } from './plan-text';

describe('plan read-back', () => {
  const plan = {
    host: 'staging.example.com',
    objective: 'Look for who can see whose data and injection. Focus on checkout.',
    intrusiveness: 'active_safe' as const,
    excludedPaths: ['/admin', '/internal'],
    roles: ['customer_a', 'customer_b'],
    minutes: 30,
    requests: 1000,
    costUsd: 8,
    releaseProven: 'hold' as const,
  };

  it('fills the template exactly', () => {
    expect(planText(plan)).toBe(
      "We will audit staging.example.com for who can see whose data and injection, with your note: \u201cFocus on checkout\u201d. Blackwing's agents will probe gently: crafted read requests that should not change data. Anything that would change data waits for your yes. They will stay out of /admin and /internal, and everything under them. They test as 2 signed-in roles, customer_a and customer_b. We stop at 30 minutes, 1,000 requests or $8 of model spend, whichever comes first. Anything Blackwing proves waits for your release.",
    );
  });

  it('reads the passive, visitor and automatic variants', () => {
    const text = planText({
      ...plan,
      intrusiveness: 'passive',
      excludedPaths: [],
      roles: [],
      minutes: 1,
      costUsd: 2.5,
      releaseProven: 'auto',
    });
    expect(text).toContain('only look, never touch: GET, HEAD and OPTIONS requests. Anything that would change data is refused.');
    expect(text).toContain('They may go anywhere on the site and test as a visitor.');
    expect(planText({ ...plan, objective: 'Look for injection flaws.' })).toContain('for injection flaws. Blackwing');
    expect(text).toContain('We stop at 1 minute, 1,000 requests or $2.50 of model spend');
    expect(text).toContain('is released to the report automatically.');
  });

  it('marks every variable as an editable field', () => {
    expect(planSegments(plan).flatMap((s) => (s.field === undefined ? [] : [s.field]))).toEqual([
      'host',
      'objective',
      'intrusiveness',
      'paths',
      'accounts',
      'limits',
      'release',
    ]);
    expect(objectivePhrase('')).toBe('the OWASP Top 10');
  });

  it('writes the results headline', () => {
    expect(resultsHeadline([])).toBe('No issues were proven.');
    expect(resultsHeadline(['critical', 'low'])).toBe('Blackwing proved 2 issues. Fix the critical one first.');
    expect(resultsHeadline(['high', 'high'])).toBe('Blackwing proved 2 issues. Start with the high-severity ones.');
    expect(resultsHeadline(['low'])).toBe('Blackwing proved 1 issue.');
  });

  it('names a decision by its method and path, without the query', () => {
    expect(decisionTitle('POST', 'https://s.example.com/rest/basket/7/checkout')).toBe('Allow POST /rest/basket/7/checkout?');
    expect(decisionTitle('get', 'https://s.example.com/vulnerabilities/xss_s/?name=x')).toBe('Allow GET /vulnerabilities/xss_s/?');
    expect(decisionTitle('POST', 'https://s.example.com/')).toBe('Allow a POST request?');
    expect(decisionTitle('PUT', '/api/orders/42?x=1')).toBe('Allow PUT /api/orders/42?');
  });

  it('reads back the whole note, and names what an approver should notice', () => {
    const long = `Look for injection flaws. ${'Try every admin variant like //admin and /admin;x. '.repeat(5)}Then the end.`;
    expect(planText({ ...plan, objective: long })).toContain('Then the end');
    expect(objectiveConflicts('Look for flaws. Also hit /admin/users and https://evil.example.com/x.', ['/admin', '/setup.php'], 'staging.example.com')).toEqual({
      excluded: ['/admin'],
      hosts: ['evil.example.com'],
    });
    expect(objectiveConflicts('Check 127.0.0.1:3092 and config.inc.php.', [], '127.0.0.1:3082').hosts).toEqual(['127.0.0.1:3092']);
    expect(objectiveConflicts('Focus on http://127.0.0.1:3082/login.php', [], '127.0.0.1:3082')).toEqual({ excluded: [], hosts: [] });
  });
});
