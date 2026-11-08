import { describe, expect, it } from 'vitest';

import { ledgerWords } from './words';

describe('ledger words', () => {
  const run = '01a1b919-e2b9-7000-8000-000000000000';

  it('reads ownership, plan edits and run control in plain words', () => {
    expect(ledgerWords('asset.verified', { method: 'http_token', origin: 'http://127.0.0.1:3082' }, 'a')).toBe(
      'Proved ownership of http://127.0.0.1:3082 by file',
    );
    expect(ledgerWords('asset.verified', { method: 'owner_attestation', origin: 'http://127.0.0.1:5077' }, 'a')).toBe(
      'Proved ownership of http://127.0.0.1:5077 by attestation',
    );
    expect(
      ledgerWords('asset.unverified', { origin: 'http://127.0.0.1:3082', reason: 'the file is gone (the site answered 404)' }, 'a'),
    ).toBe('Ownership of http://127.0.0.1:3082 lapsed: the file is gone (the site answered 404)');
    expect(ledgerWords('gate1.amend', { version: 3, changed: 'objective,excludedPaths,budgetRequests,budgetSeconds' }, 'r')).toBe(
      'Edited the plan (version 3): what to look for, paths to avoid, limits',
    );
    expect(ledgerWords('run.started', { requestId: 'r' }, run)).toBe('Started audit 01A1B919');
    expect(ledgerWords('run.pause', {}, run)).toBe('Paused the audit');
    expect(ledgerWords('run.resume', {}, run)).toBe('Resumed the audit');
    expect(ledgerWords('finding.retest', {}, 'f')).toBe('Asked Blackwing to retest a finding');
  });

  it('says what an unanswered request was, and that it was not sent', () => {
    expect(ledgerWords('gate2.expired', { method: 'post', url: 'http://127.0.0.1:3001/api/Users?x=1' }, 'g')).toBe(
      'No answer in time: POST /api/Users?x=1 was not sent',
    );
    expect(ledgerWords('gate2.expired', {}, 'g')).toBe('No answer in time: the request was not sent');
  });

  it('leaves every other action to the shared label', () => {
    expect(ledgerWords('gate1.approve', {}, 'r')).toBeNull();
    expect(ledgerWords('something.new', {}, 'x')).toBeNull();
  });
});
