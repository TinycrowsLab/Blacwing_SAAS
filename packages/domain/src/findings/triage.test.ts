import { describe, expect, it } from 'vitest';

import { LIMITS, type FindingStatus } from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  FindingTriageError,
  IllegalFindingTransitionError,
  TRIAGE_AUDIT_ACTION,
  TRIAGE_GATE_DECISION,
  TRIAGE_TARGETS,
  type TriageCanonicalFacts,
  type TriageFindingFacts,
  type TriageInput,
  type TriageTarget,
  transitionFinding,
} from './triage.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const FUTURE = '2031-06-01T00:00:00.000Z';
const ACTOR = newId();
const FINDING_ID = newId();
const CANONICAL_ID = newId();

const ALL_STATUSES: readonly FindingStatus[] = [
  'candidate',
  'validating',
  'confirmed',
  'suspected',
  'released',
  'rejected_false_positive',
  'duplicate',
  'accepted_risk',
  'fixed',
  'returned',
];

function facts(overrides: Partial<TriageFindingFacts> = {}): TriageFindingFacts {
  return {
    id: FINDING_ID,
    status: 'confirmed',
    stateVersion: 3,
    assetType: 'web_app',
    scored: true,
    evidenceBound: true,
    hasDuplicates: false,
    ...overrides,
  };
}

function canonicalFacts(overrides: Partial<TriageCanonicalFacts> = {}): TriageCanonicalFacts {
  return { id: CANONICAL_ID, status: 'confirmed', assetType: 'web_app', ...overrides };
}

/** A request that passes every guard for `to`; tests override one field at a time. */
function request(to: TriageTarget, overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    to,
    actorId: ACTOR,
    reason: 'Reproduced with the replay script',
    now: NOW,
    ...(to === 'accepted_risk' ? { expiresAt: FUTURE } : {}),
    ...(to === 'duplicate' ? { canonicalFindingId: CANONICAL_ID } : {}),
    ...overrides,
  };
}

/** The refusal thrown by `fn`, asserting that one is thrown. */
function refusalOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the transition to be refused');
}

describe('transitionFinding: the valid transitions out of confirmed', () => {
  it.each(TRIAGE_TARGETS)('moves a confirmed finding to %s', (to) => {
    const result = transitionFinding(facts(), request(to), canonicalFacts());
    expect(result.next.status).toBe(to);
    expect(result.auditIntent.to).toBe(to);
    expect(result.auditIntent.from).toBe('confirmed');
  });

  it('bumps state_version by one from the version it read', () => {
    const result = transitionFinding(facts({ stateVersion: 7 }), request('released'));
    expect(result.next.stateVersion).toBe(8);
  });

  it('writes the released fields only for a release', () => {
    const released = transitionFinding(facts(), request('released'));
    expect(released.next).toEqual({
      status: 'released',
      stateVersion: 4,
      acceptedRisk: null,
      duplicateOf: null,
      releasedBy: ACTOR,
      releasedAt: NOW,
    });
  });

  it('stores the reason and expiry of an accepted risk, and nothing else', () => {
    const result = transitionFinding(
      facts(),
      request('accepted_risk', { reason: '  Compensating control  ' }),
    );
    expect(result.next.acceptedRisk).toEqual({
      reason: 'Compensating control',
      expiresAt: FUTURE,
    });
    expect(result.next.releasedBy).toBeNull();
    expect(result.next.releasedAt).toBeNull();
  });

  it('links a duplicate to its canonical finding without releasing it', () => {
    const result = transitionFinding(facts(), request('duplicate'), canonicalFacts());
    expect(result.next.duplicateOf).toBe(CANONICAL_ID);
    expect(result.next.releasedBy).toBeNull();
    expect(result.next.releasedAt).toBeNull();
    expect(result.next.acceptedRisk).toBeNull();
  });

  it('keeps no release or risk fields on a false-positive rejection', () => {
    const result = transitionFinding(facts(), request('rejected_false_positive'));
    expect(result.next).toEqual({
      status: 'rejected_false_positive',
      stateVersion: 4,
      acceptedRisk: null,
      duplicateOf: null,
      releasedBy: null,
      releasedAt: null,
    });
  });
});

describe('transitionFinding: illegal transitions', () => {
  const others = ALL_STATUSES.filter((status) => status !== 'confirmed');

  it.each(others.flatMap((status) => TRIAGE_TARGETS.map((to) => [status, to] as const)))(
    'refuses %s to %s with FINDING_ILLEGAL_TRANSITION',
    (status, to) => {
      const error = refusalOf(() =>
        transitionFinding(facts({ status }), request(to), canonicalFacts()),
      );
      expect(error).toBeInstanceOf(IllegalFindingTransitionError);
      expect(error.code).toBe('FINDING_ILLEGAL_TRANSITION');
      expect(error.httpStatus).toBe(409);
      expect(error.retryable).toBe(false);
      expect((error as IllegalFindingTransitionError).from).toBe(status);
      expect((error as IllegalFindingTransitionError).to).toBe(to);
    },
  );

  it('refuses an unknown target even from confirmed', () => {
    const error = refusalOf(() =>
      transitionFinding(facts(), { ...request('released'), to: 'fixed' as TriageTarget }),
    );
    expect(error).toBeInstanceOf(IllegalFindingTransitionError);
  });

  it('checks the status before the reason, so a blank reason on a closed finding is still illegal', () => {
    const error = refusalOf(() =>
      transitionFinding(facts({ status: 'released' }), request('released', { reason: '   ' })),
    );
    expect(error.code).toBe('FINDING_ILLEGAL_TRANSITION');
  });

  it('does not expose the requested target text in the client detail', () => {
    const error = refusalOf(() =>
      transitionFinding(facts({ status: 'released' }), {
        ...request('released'),
        to: 'bogus<script>' as TriageTarget,
      }),
    );
    expect(error.code).toBe('FINDING_ILLEGAL_TRANSITION');
    expect(error.detail).not.toContain('bogus');
  });
});

describe('transitionFinding: the Gate 3 decision and the audit intent', () => {
  it.each(TRIAGE_TARGETS)('records a gate 3 row for %s with the mapped outcome', (to) => {
    const result = transitionFinding(facts(), request(to), canonicalFacts());
    expect(result.gate).toEqual({
      gate: 3,
      subjectType: 'finding',
      subjectId: FINDING_ID,
      decision: TRIAGE_GATE_DECISION[to],
      requesterId: null,
      actorId: ACTOR,
      reason: 'Reproduced with the replay script',
      decidedAt: NOW,
      timeoutAt: null,
      auto: false,
    });
  });

  it('approves a release and an accepted risk, and rejects the other two', () => {
    expect(TRIAGE_GATE_DECISION).toEqual({
      released: 'approved',
      accepted_risk: 'approved',
      rejected_false_positive: 'rejected',
      duplicate: 'rejected',
    });
  });

  it.each(TRIAGE_TARGETS)('audits %s under its §8.8 action name', (to) => {
    const result = transitionFinding(facts(), request(to), canonicalFacts());
    expect(result.auditIntent).toEqual({
      action: TRIAGE_AUDIT_ACTION[to],
      findingId: FINDING_ID,
      from: 'confirmed',
      to,
      actorId: ACTOR,
    });
  });

  it('names the four §8.8 finding actions', () => {
    expect(Object.values(TRIAGE_AUDIT_ACTION).sort()).toEqual([
      'finding.marked_duplicate',
      'finding.rejected',
      'finding.released',
      'finding.risk_accepted',
    ]);
  });

  it('keeps the reason text out of the audit intent', () => {
    const result = transitionFinding(
      facts(),
      request('rejected_false_positive', { reason: 'secret-note' }),
    );
    expect(JSON.stringify(result.auditIntent)).not.toContain('secret-note');
  });
});

describe('transitionFinding: the reason', () => {
  it.each(['', '   ', '\t\n'])(
    'refuses the blank reason %j with TRIAGE_REASON_REQUIRED',
    (reason) => {
      for (const to of TRIAGE_TARGETS) {
        const error = refusalOf(() =>
          transitionFinding(facts(), request(to, { reason }), canonicalFacts()),
        );
        expect(error).toBeInstanceOf(FindingTriageError);
        expect(error.code).toBe('TRIAGE_REASON_REQUIRED');
        expect(error.httpStatus).toBe(422);
      }
    },
  );

  it('accepts a reason of exactly the maximum length and refuses one character more', () => {
    const atMax = 'r'.repeat(LIMITS.reasonMax);
    expect(() => transitionFinding(facts(), request('released', { reason: atMax }))).not.toThrow();
    const error = refusalOf(() =>
      transitionFinding(facts(), request('released', { reason: `${atMax}r` })),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

describe('transitionFinding: accepted risk expiry', () => {
  it('refuses an accepted risk without an expiry', () => {
    const error = refusalOf(() =>
      transitionFinding(facts(), request('accepted_risk', { expiresAt: undefined })),
    );
    expect(error.code).toBe('TRIAGE_EXPIRY_INVALID');
  });

  it.each([
    ['a past instant', '2029-06-01T00:00:00.000Z'],
    ['the decision instant itself', '2030-01-01T00:00:00.000Z'],
    ['a string that is not a date', 'next tuesday'],
    ['an instant with no offset', '2031-06-01T00:00:00'],
    ['an instant with no offset and milliseconds', '2031-06-01T00:00:00.000'],
    ['an empty string', ''],
    ['an impossible date', '2031-02-30T00:00:00.000Z'],
  ])('refuses %s', (_label, expiresAt) => {
    const error = refusalOf(() =>
      transitionFinding(facts(), request('accepted_risk', { expiresAt })),
    );
    expect(error.code).toBe('TRIAGE_EXPIRY_INVALID');
    expect(error.httpStatus).toBe(422);
  });

  it('refuses any expiry when the decision clock is invalid', () => {
    const error = refusalOf(() =>
      transitionFinding(facts(), request('accepted_risk', { now: new Date('not a date') })),
    );
    expect(error.code).toBe('TRIAGE_EXPIRY_INVALID');
  });

  it('normalises an offset expiry to canonical UTC milliseconds', () => {
    const result = transitionFinding(
      facts(),
      request('accepted_risk', { expiresAt: '2031-06-01T02:00:00+02:00' }),
    );
    expect(result.next.acceptedRisk?.expiresAt).toBe('2031-06-01T00:00:00.000Z');
  });

  it('accepts a Z expiry written in lower case and with fractional seconds', () => {
    const result = transitionFinding(
      facts(),
      request('accepted_risk', { expiresAt: '2031-06-01t00:00:00.123456z' }),
    );
    expect(result.next.acceptedRisk?.expiresAt).toBe('2031-06-01T00:00:00.123Z');
  });

  it('refuses an accepted risk whose offset expiry is already past once converted', () => {
    const error = refusalOf(() =>
      transitionFinding(
        facts(),
        request('accepted_risk', { expiresAt: '2030-01-01T01:00:00+02:00' }),
      ),
    );
    expect(error.code).toBe('TRIAGE_EXPIRY_INVALID');
  });
});

describe('transitionFinding: duplicates', () => {
  it('refuses a duplicate without a canonical finding id', () => {
    const error = refusalOf(() =>
      transitionFinding(
        facts(),
        request('duplicate', { canonicalFindingId: undefined }),
        canonicalFacts(),
      ),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it('refuses a canonical id that is not a UUIDv7', () => {
    for (const canonicalFindingId of ['not-an-id', '', '00000000-0000-4000-8000-000000000000']) {
      const error = refusalOf(() =>
        transitionFinding(facts(), request('duplicate', { canonicalFindingId }), canonicalFacts()),
      );
      expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
    }
  });

  it('refuses a finding that is its own canonical finding', () => {
    const error = refusalOf(() =>
      transitionFinding(
        facts(),
        request('duplicate', { canonicalFindingId: FINDING_ID }),
        canonicalFacts({ id: FINDING_ID }),
      ),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
    expect(error.detail).toContain('itself');
  });

  it('refuses a canonical finding that is not visible in this tenant (cross-tenant ids look missing)', () => {
    for (const canonical of [null, undefined]) {
      const error = refusalOf(() => transitionFinding(facts(), request('duplicate'), canonical));
      expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
    }
  });

  it('refuses facts that do not describe the id the request named', () => {
    const error = refusalOf(() =>
      transitionFinding(facts(), request('duplicate'), canonicalFacts({ id: newId() })),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it.each([
    'candidate',
    'validating',
    'suspected',
    'duplicate',
    'rejected_false_positive',
  ] as const)('refuses a canonical finding in status %s', (status) => {
    const error = refusalOf(() =>
      transitionFinding(facts(), request('duplicate'), canonicalFacts({ status })),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it.each(['confirmed', 'released', 'accepted_risk', 'fixed', 'returned'] as const)(
    'accepts a canonical finding in status %s',
    (status) => {
      expect(() =>
        transitionFinding(facts(), request('duplicate'), canonicalFacts({ status })),
      ).not.toThrow();
    },
  );

  it('refuses a canonical finding on another asset class', () => {
    const error = refusalOf(() =>
      transitionFinding(
        facts({ assetType: 'web_app' }),
        request('duplicate'),
        canonicalFacts({ assetType: 'api' }),
      ),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
    expect(error.detail).toContain('asset class');
  });

  it('refuses when either asset class is unknown, because the class cannot be shown to match', () => {
    expect(
      refusalOf(() =>
        transitionFinding(facts({ assetType: null }), request('duplicate'), canonicalFacts()),
      ).code,
    ).toBe('TRIAGE_CANONICAL_INVALID');
    expect(
      refusalOf(() =>
        transitionFinding(facts(), request('duplicate'), canonicalFacts({ assetType: null })),
      ).code,
    ).toBe('TRIAGE_CANONICAL_INVALID');
  });

  it('refuses to make a finding a duplicate when other findings already duplicate it (no chains, no cycles)', () => {
    const error = refusalOf(() =>
      transitionFinding(facts({ hasDuplicates: true }), request('duplicate'), canonicalFacts()),
    );
    expect(error.code).toBe('TRIAGE_CANONICAL_INVALID');
  });
});

describe('transitionFinding: release preconditions', () => {
  it('refuses a release of a finding with no scored severity', () => {
    const error = refusalOf(() => transitionFinding(facts({ scored: false }), request('released')));
    expect(error.code).toBe('TRIAGE_PRECONDITION_FAILED');
    expect(error.httpStatus).toBe(409);
  });

  it('refuses a release of a finding with no bound evidence', () => {
    const error = refusalOf(() =>
      transitionFinding(facts({ evidenceBound: false }), request('released')),
    );
    expect(error.code).toBe('TRIAGE_PRECONDITION_FAILED');
  });

  it('does not require a severity or evidence for the other targets', () => {
    const bare = facts({ scored: false, evidenceBound: false });
    expect(() => transitionFinding(bare, request('rejected_false_positive'))).not.toThrow();
    expect(() => transitionFinding(bare, request('accepted_risk'))).not.toThrow();
    expect(() => transitionFinding(bare, request('duplicate'), canonicalFacts())).not.toThrow();
  });
});

describe('transitionFinding: inputs', () => {
  it('never mutates the facts or the request it is given', () => {
    const finding = Object.freeze(facts());
    const req = Object.freeze(request('accepted_risk', { reason: ' kept ' }));
    expect(() => transitionFinding(finding, req)).not.toThrow();
    expect(finding.status).toBe('confirmed');
    expect(req.reason).toBe(' kept ');
  });

  it('refuses a stateVersion that cannot be advanced', () => {
    expect(() => transitionFinding(facts({ stateVersion: -1 }), request('released'))).toThrow();
  });
});

describe('error types', () => {
  it('uses the registry codes for every refusal', () => {
    expect(new IllegalFindingTransitionError('released', 'released').code).toBe(
      'FINDING_ILLEGAL_TRANSITION',
    );
    expect(new FindingTriageError('TRIAGE_REASON_REQUIRED', 'x').httpStatus).toBe(422);
    expect(new FindingTriageError('TRIAGE_PRECONDITION_FAILED', 'x').httpStatus).toBe(409);
  });
});
