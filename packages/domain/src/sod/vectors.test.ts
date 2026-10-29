import { describe, expect, it } from 'vitest';

import { SodViolationError } from './error.js';
import { assertDifferentActors } from './primitives.js';
import { SOD_VECTORS, type SodVector } from './vectors.js';

/** The service helper's decision for one vector: `deny` only for a SoD refusal, anything else is a failure. */
function serviceDecision(vector: SodVector): 'allow' | 'deny' | 'other' {
  try {
    assertDifferentActors(vector.requesterId, vector.approverId, 'vector');
    return 'allow';
  } catch (error) {
    return error instanceof SodViolationError ? 'deny' : 'other';
  }
}

describe('shared SoD vectors against the service helper', () => {
  it.each(SOD_VECTORS)('$name refuses only when same is true', (vector) => {
    expect(serviceDecision(vector)).toBe(vector.same ? 'deny' : 'allow');
  });
});
