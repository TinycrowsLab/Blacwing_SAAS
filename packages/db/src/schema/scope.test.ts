import { describe, expect, it } from 'vitest';

import {
  authorisableIntrusivenessSchema,
  RUN_MODES,
  RUN_TRIGGERS,
  runModeSchema,
  runTriggerSchema,
} from '@blackwing/contracts';

import { MAX_INTRUSIVENESS } from './scope.js';

// The database CHECK lists are typed from these tuples; the contract schemas validate at the API. A drift
// between the two would let the database accept a value the API refuses (or the reverse), so they must match.
describe('assessment request enums match the contracts', () => {
  it('allows the same intrusiveness classes as authorisableIntrusivenessSchema', () => {
    expect([...MAX_INTRUSIVENESS].sort()).toEqual(
      [...authorisableIntrusivenessSchema.options].sort(),
    );
  });

  it('never allows destructive (§8.3)', () => {
    expect(MAX_INTRUSIVENESS).not.toContain('destructive');
  });

  it('uses the contract modes and triggers', () => {
    expect([...RUN_MODES]).toEqual([...runModeSchema.options]);
    expect([...RUN_TRIGGERS]).toEqual([...runTriggerSchema.options]);
  });
});
