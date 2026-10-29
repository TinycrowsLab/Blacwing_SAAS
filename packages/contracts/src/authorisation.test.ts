import { describe, expect, it } from 'vitest';

import { SA_STATUSES, saStatusSchema } from './authorisation.js';

describe('standing authorisation statuses', () => {
  it('are exactly the five lifecycle states of AUTHZ-001, in order', () => {
    expect(SA_STATUSES).toEqual(['draft', 'pending_approval', 'active', 'expired', 'revoked']);
  });

  it('accept every status and reject anything else, including case and whitespace variants', () => {
    for (const status of SA_STATUSES) expect(saStatusSchema.parse(status)).toBe(status);
    for (const value of ['Active', ' active', 'destructive', '', 'rotating', null, 1]) {
      expect(saStatusSchema.safeParse(value).success).toBe(false);
    }
  });
});
