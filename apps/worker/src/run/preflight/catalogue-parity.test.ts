// #579: the domain preflight catalogue and the check ids ORCH-003 registers implementations against must
// stay identical. The workflow bundle cannot import @blackwing/domain (its root index pulls in Node
// built-ins), so the two lists are pinned here instead of shared by import.

import { describe, expect, it } from 'vitest';

import {
  dryRunDefinitions,
  PREFLIGHT_CATALOGUE,
  PREFLIGHT_CHECK_IDS as CATALOGUE_CHECK_IDS,
} from '@blackwing/domain';

import { PREFLIGHT_CHECK_IDS } from './types.js';

describe('preflight catalogue parity (#579, ORCH-003)', () => {
  it('lists the same check ids, in the same order, as ORCH-003 registers', () => {
    expect([...CATALOGUE_CHECK_IDS]).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(PREFLIGHT_CATALOGUE.map((definition) => definition.id)).toEqual([
      ...PREFLIGHT_CHECK_IDS,
    ]);
  });

  it('never classes a side-effecting ORCH-003 check as dry-run safe', () => {
    const readOnly = dryRunDefinitions().map((definition) => definition.id);
    expect(readOnly).not.toContain('loginPerRole');
    expect(readOnly).not.toContain('deliverSocNotice');
    expect(readOnly.every((id) => (PREFLIGHT_CHECK_IDS as readonly string[]).includes(id))).toBe(
      true,
    );
  });
});
