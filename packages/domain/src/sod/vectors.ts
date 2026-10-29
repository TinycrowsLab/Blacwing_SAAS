/**
 * Shared SoD test vectors (#352). Each vector is one (requester, approver) pair. The service helper
 * (`assertDifferentActors`) and the Cedar condition (`sodCedarCondition`) must both refuse exactly the pairs marked
 * `same` and allow the rest. `vectors.test.ts` and `cedar.parity.test.ts` both consume this list.
 */
export interface SodVector {
  readonly name: string;
  readonly requesterId: string;
  readonly approverId: string;
  /** True when the two ids name the same actor and the check must refuse. */
  readonly same: boolean;
}

const USER = '0190f3a2-7c1e-7d2a-9b4f-3e5a6c7d8e9f';
const OTHER = '0190f3a2-7c1e-7d2a-9b4f-3e5a6c7d8ea0';

export const SOD_VECTORS: readonly SodVector[] = [
  { name: 'identical ids', requesterId: USER, approverId: USER, same: true },
  { name: 'distinct ids', requesterId: USER, approverId: OTHER, same: false },
  {
    name: 'case differs (distinct identity)',
    requesterId: USER,
    approverId: USER.toUpperCase(),
    same: false,
  },
  { name: 'prefix of the other id', requesterId: USER, approverId: USER.slice(0, -1), same: false },
  { name: 'identical short id', requesterId: 'usr_a', approverId: 'usr_a', same: true },
  { name: 'distinct short id', requesterId: 'usr_a', approverId: 'usr_b', same: false },
];
