import { describe, expect, it } from 'vitest';

import { ERROR_CODE_LIST, problemTypeFor } from '@blackwing/errors';

import {
  BASE_PROBLEM_CODES,
  createProblemRegistry,
  ProblemRegistry,
  problemRegistry,
  wireCodeFor,
} from './registry.js';

/** CONTEXT_PACK §9 / API-004 requirement 3. */
const EXPECTED_STATUS: Readonly<Record<string, number>> = {
  validation_failed: 422,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  precondition_required: 428,
  rate_limited: 429,
  idempotency_conflict: 409,
  idempotency_key_required: 400,
  idempotency_in_progress: 409,
  idempotency_result_too_large: 409,
  idempotency_unavailable: 503,
  tenant_context_missing: 500,
  internal_error: 500,
};

describe('problem registry', () => {
  it.each(Object.entries(EXPECTED_STATUS))('maps %s to HTTP %i', (code, status) => {
    const registry = createProblemRegistry();
    expect(registry.get(code)?.status).toBe(status);
    expect(registry.get(code)?.title.length).toBeGreaterThan(0);
  });

  it('builds https://errors.blackwing.dev/{code} types', () => {
    const entry = problemRegistry.get('not_found');
    expect(entry && problemRegistry.typeFor(entry)).toBe('https://errors.blackwing.dev/not_found');
  });

  it('seeds every FOUND AppError code with a unique snake_case wire code', () => {
    const registry = createProblemRegistry();
    const wires = ERROR_CODE_LIST.map((code) => wireCodeFor(code));
    expect(new Set(wires).size).toBe(wires.length);
    for (const code of ERROR_CODE_LIST) {
      const wire = wireCodeFor(code);
      expect(wire).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      expect(registry.has(wire)).toBe(true);
      expect(problemTypeFor(code)).toContain(code);
    }
    expect(wireCodeFor('FORBIDDEN')).toBe('permission_denied');
    expect(wireCodeFor('INTERNAL')).toBe('internal_error');
    expect(registry.get('permission_denied')?.status).toBe(403);
  });

  it('keeps the base table consistent with the registry', () => {
    const registry = createProblemRegistry();
    for (const [code, spec] of Object.entries(BASE_PROBLEM_CODES))
      expect(registry.get(code)?.status).toBe(spec.status);
  });

  it('is extensible, idempotent for identical entries and strict for conflicting ones', () => {
    const registry = createProblemRegistry();
    registry.register('run_locked', { status: 423, title: 'Run locked' });
    registry.register('run_locked', { status: 423, title: 'Run locked' });
    expect(registry.get('run_locked')?.typeSuffix).toBe('run_locked');
    expect(() => {
      registry.register('run_locked', { status: 409, title: 'Run locked' });
    }).toThrow();
    expect(() => {
      registry.register('Bad-Code', { status: 400, title: 'x' });
    }).toThrow(RangeError);
    expect(() => {
      registry.register('ok_code', { status: 200, title: 'x' });
    }).toThrow(RangeError);
    expect(() => {
      registry.register('ok_code', { status: 400, title: ' ' });
    }).toThrow(RangeError);
  });

  it('falls back to internal_error for an unregistered code', () => {
    const registry = new ProblemRegistry();
    registry.register('internal_error', { status: 500, title: 'Internal server error' });
    expect(registry.resolve('nope').code).toBe('internal_error');
  });
});
