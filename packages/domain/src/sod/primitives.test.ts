import { describe, expect, it } from 'vitest';

import { SodViolationError, type SodViolationReason } from './error.js';
import {
  APPROVER_ROLES,
  assertCanApprove,
  assertDifferentActors,
  assertMinApprovers,
  canApprove,
  SERVICE_ROLES,
} from './primitives.js';

import type { SodWarnSink } from './index.js';

const REQUESTER = 'usr_requester';
const APPROVER = 'usr_approver';

function reasonOf(fn: () => void): SodViolationReason | 'no-throw' | 'other' {
  try {
    fn();
    return 'no-throw';
  } catch (error) {
    return error instanceof SodViolationError ? error.reason : 'other';
  }
}

function recordingLogger(): SodWarnSink & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    warn(fields, message) {
      expect(message).toBe('sod.violation');
      calls.push({ ...fields });
    },
  };
}

describe('assertDifferentActors', () => {
  it('passes for two distinct actors', () => {
    expect(() => {
      assertDifferentActors(REQUESTER, APPROVER, 'sa.approve');
    }).not.toThrow();
  });

  it('throws requester_equals_approver when the ids are equal', () => {
    expect(
      reasonOf(() => {
        assertDifferentActors(REQUESTER, REQUESTER, 'sa.approve');
      }),
    ).toBe('requester_equals_approver');
  });

  it('fails closed on a null or empty requester or approver', () => {
    expect(
      reasonOf(() => {
        assertDifferentActors(null, APPROVER, 'gate1.approve');
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertDifferentActors(undefined, APPROVER, 'gate1.approve');
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertDifferentActors(REQUESTER, null, 'gate1.approve');
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertDifferentActors(REQUESTER, '', 'gate1.approve');
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertDifferentActors('', '', 'gate1.approve');
      }),
    ).toBe('null_actor');
  });

  it('treats ids as identity: a case change is a different actor', () => {
    expect(() => {
      assertDifferentActors(REQUESTER, REQUESTER.toUpperCase(), 'gate2.decide');
    }).not.toThrow();
  });

  it('logs at warn with context, ids and reason before throwing', () => {
    const logger = recordingLogger();
    expect(() => {
      assertDifferentActors(REQUESTER, REQUESTER, 'gate2.decide', { logger });
    }).toThrow(SodViolationError);
    expect(logger.calls).toEqual([
      {
        context: 'gate2.decide',
        requesterId: REQUESTER,
        actorId: REQUESTER,
        reason: 'requester_equals_approver',
      },
    ]);
  });

  it('does not log a passing check', () => {
    const logger = recordingLogger();
    assertDifferentActors(REQUESTER, APPROVER, 'gate2.decide', { logger });
    expect(logger.calls).toHaveLength(0);
  });
});

describe('assertMinApprovers', () => {
  it('passes with the default min of one distinct approver', () => {
    expect(() => {
      assertMinApprovers([APPROVER]);
    }).not.toThrow();
  });

  it('passes when N distinct approvers other than the requester are present', () => {
    expect(() => {
      assertMinApprovers(['usr_a', 'usr_b'], 2, REQUESTER);
    }).not.toThrow();
  });

  it('counts a duplicate approver id once, so it can fail the minimum', () => {
    expect(
      reasonOf(() => {
        assertMinApprovers(['usr_a', 'usr_a'], 2);
      }),
    ).toBe('insufficient_approvers');
    expect(() => {
      assertMinApprovers(['usr_a', 'usr_a'], 1);
    }).not.toThrow();
  });

  it('never counts the requester as an approver', () => {
    expect(
      reasonOf(() => {
        assertMinApprovers([REQUESTER], 1, REQUESTER);
      }),
    ).toBe('insufficient_approvers');
    expect(
      reasonOf(() => {
        assertMinApprovers([REQUESTER, 'usr_a'], 2, REQUESTER);
      }),
    ).toBe('insufficient_approvers');
  });

  it('throws insufficient_approvers for an empty list', () => {
    expect(
      reasonOf(() => {
        assertMinApprovers([]);
      }),
    ).toBe('insufficient_approvers');
  });

  it('fails closed on a null approver id', () => {
    expect(
      reasonOf(() => {
        assertMinApprovers(['usr_a', null], 1);
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertMinApprovers([undefined], 1);
      }),
    ).toBe('null_actor');
  });

  it('fails closed when a requester is supplied but empty', () => {
    expect(
      reasonOf(() => {
        assertMinApprovers(['usr_a'], 1, null);
      }),
    ).toBe('null_actor');
    expect(
      reasonOf(() => {
        assertMinApprovers(['usr_a'], 1, '');
      }),
    ).toBe('null_actor');
  });

  it('rejects a min that is not a positive integer as invalid input, not as a SoD outcome', () => {
    expect(() => {
      assertMinApprovers(['usr_a'], 0);
    }).toThrow(/positive integer/);
    expect(() => {
      assertMinApprovers(['usr_a'], -1);
    }).toThrow(/positive integer/);
    expect(() => {
      assertMinApprovers(['usr_a'], 1.5);
    }).toThrow(/positive integer/);
    expect(() => {
      assertMinApprovers(['usr_a'], Number.NaN);
    }).toThrow(/positive integer/);
  });

  it('logs the refusal with its context', () => {
    const logger = recordingLogger();
    expect(() => {
      assertMinApprovers([], 2, REQUESTER, 'gate2.decide', { logger });
    }).toThrow();
    expect(logger.calls).toEqual([
      {
        context: 'gate2.decide',
        requesterId: REQUESTER,
        actorId: null,
        reason: 'insufficient_approvers',
      },
    ]);
  });
});

describe('canApprove', () => {
  it('allows an asset owner', () => {
    expect(canApprove(['asset_owner'])).toBe(true);
    expect(canApprove(['developer', 'asset_owner'])).toBe(true);
  });

  it('refuses the roles that do not approve (org_admin, appsec_engineer, developer, auditor)', () => {
    for (const role of ['org_admin', 'appsec_engineer', 'developer', 'auditor']) {
      expect(canApprove([role])).toBe(false);
    }
  });

  it('refuses CI and service principals, even alongside an approver role', () => {
    expect(canApprove(['ci_pipeline'])).toBe(false);
    expect(canApprove(['asset_owner', 'ci_pipeline'])).toBe(false);
  });

  it('refuses an empty or unknown role list (deny by default)', () => {
    expect(canApprove([])).toBe(false);
    expect(canApprove(['platform_operator', 'root'])).toBe(false);
  });

  it('exposes the approver and service role constants', () => {
    expect(APPROVER_ROLES).toEqual(['asset_owner']);
    expect(SERVICE_ROLES).toEqual(['ci_pipeline']);
  });
});

describe('assertCanApprove', () => {
  it('passes for an asset owner who is not the requester', () => {
    expect(() => {
      assertCanApprove(APPROVER, ['asset_owner'], REQUESTER, 'sa.approve');
    }).not.toThrow();
  });

  it('throws ineligible_approver for a CI principal', () => {
    expect(
      reasonOf(() => {
        assertCanApprove('svc_ci', ['ci_pipeline'], REQUESTER, 'sa.approve');
      }),
    ).toBe('ineligible_approver');
  });

  it('throws ineligible_approver for an org_admin, who holds no approval permission', () => {
    expect(
      reasonOf(() => {
        assertCanApprove(APPROVER, ['org_admin'], REQUESTER, 'sa.approve');
      }),
    ).toBe('ineligible_approver');
  });

  it('throws requester_equals_approver even when the requester is an asset owner', () => {
    expect(
      reasonOf(() => {
        assertCanApprove(REQUESTER, ['asset_owner'], REQUESTER, 'sa.approve');
      }),
    ).toBe('requester_equals_approver');
  });

  it('fails closed on a missing approver', () => {
    expect(
      reasonOf(() => {
        assertCanApprove(null, ['asset_owner'], REQUESTER, 'sa.approve');
      }),
    ).toBe('null_actor');
  });
});
