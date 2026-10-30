import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  ACCESS_MATRIX_AUDIT_EVENT,
  accessMatrixEvaluator,
  ACCESS_MATRIX_REASONS,
} from './access-matrix.js';
import { observationWith } from './fixtures.js';

import type { RoleAccess, SignalStore } from './signals.js';

const REPLAY_ID = '0190a000-0000-7000-8000-000000000001';
const deny = {
  functionId: 'view_admin_panel',
  actingRole: 'customer',
  comparisonRoles: ['admin'],
  expected: 'deny',
} as const;
const allow = { ...deny, expected: 'allow' } as const;

function evaluate(rows: readonly RoleAccess[] | undefined, p: unknown = deny) {
  const store: SignalStore = (id) =>
    id === REPLAY_ID && rows !== undefined ? { access: rows } : undefined;
  return accessMatrixEvaluator(store)(observationWith([], REPLAY_ID), p);
}

const customer = (outcome: RoleAccess['outcome']): RoleAccess => ({ role: 'customer', outcome });
const admin = (outcome: RoleAccess['outcome']): RoleAccess => ({ role: 'admin', outcome });

describe('access_matrix evaluator', () => {
  it('fires when the acting role reaches a resource the matrix marks deny', () => {
    expect(evaluate([customer('allow'), admin('allow')])).toEqual({
      matched: true,
      reason: ACCESS_MATRIX_REASONS.allowedWhenDenied,
      auditEvent: ACCESS_MATRIX_AUDIT_EVENT,
    });
  });

  it('does not fire when access matches the expected denial', () => {
    expect(evaluate([customer('deny'), admin('allow')])).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.deniedAsExpected,
    });
  });

  it('does not fire when the binding expects allow, since a denial is then not an authorisation violation', () => {
    expect(evaluate([customer('deny'), admin('allow')], allow)).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.expectationNotDeny,
    });
  });

  it('is Suspected on an expired or locked-out session and never guesses', () => {
    expect(evaluate([customer('error'), admin('allow')])).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.sessionError,
    });
    expect(evaluate([customer('allow'), admin('error')]).matched).toBe(false);
  });

  it('is Suspected when the acting or a comparison role has no observation', () => {
    expect(evaluate([admin('allow')])).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.missingObservation,
    });
    expect(evaluate([customer('allow')])).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.missingObservation,
    });
  });

  it('is Suspected when a role has two observations, which cannot be told apart', () => {
    expect(evaluate([customer('allow'), customer('deny'), admin('allow')])).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.duplicateObservation,
    });
  });

  it('is Suspected when no access signal was recorded for the replay', () => {
    expect(evaluate(undefined)).toEqual({
      matched: false,
      reason: ACCESS_MATRIX_REASONS.noAccessSignal,
    });
  });

  it('refuses a binding whose acting role is its own comparison role', () => {
    expect(() => evaluate([customer('allow')], { ...deny, comparisonRoles: ['customer'] })).toThrow(
      ValidationError,
    );
  });
});
