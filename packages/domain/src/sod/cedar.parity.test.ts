import { isAuthorized, type Entities, type Schema } from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it } from 'vitest';

import { sodCedarCondition } from './cedar.js';
import { SodViolationError } from './error.js';
import { assertDifferentActors } from './primitives.js';
import { SOD_VECTORS, type SodVector } from './vectors.js';

/**
 * Parity between the three SoD layers that can be exercised here (#352): the Cedar condition, the service helper and
 * the shared vectors. The DB layer is covered by the integration test in packages/db. The schema is the smallest
 * one that carries `requesterId` and `id`, validated on every request so a missing attribute fails closed.
 */

const schema: Schema = {
  '': {
    entityTypes: {
      User: { shape: { type: 'Record', attributes: { id: { type: 'String', required: true } } } },
      Doc: {
        shape: { type: 'Record', attributes: { requesterId: { type: 'String', required: true } } },
      },
    },
    actions: {
      approve: { appliesTo: { principalTypes: ['User'], resourceTypes: ['Doc'] } },
    },
  },
} as unknown as Schema;

const POLICY = `
permit (principal, action, resource);
@id("sod.requester-equals-approver")
forbid (principal, action, resource) when { ${sodCedarCondition()} };
`;

function cedarDecision(vector: SodVector): 'allow' | 'deny' {
  const entities: Entities = [
    {
      uid: { type: 'User', id: vector.approverId },
      attrs: { id: vector.approverId },
      parents: [],
    },
    {
      uid: { type: 'Doc', id: 'doc_1' },
      attrs: { requesterId: vector.requesterId },
      parents: [],
    },
  ];
  const answer = isAuthorized({
    principal: { type: 'User', id: vector.approverId },
    action: { type: 'Action', id: 'approve' },
    resource: { type: 'Doc', id: 'doc_1' },
    context: {},
    policies: { staticPolicies: POLICY },
    entities,
    schema,
    validateRequest: true,
  });
  if (answer.type === 'failure') return 'deny';
  return answer.response.decision === 'allow' ? 'allow' : 'deny';
}

function serviceDecision(vector: SodVector): 'allow' | 'deny' | 'other' {
  try {
    assertDifferentActors(vector.requesterId, vector.approverId, 'parity');
    return 'allow';
  } catch (error) {
    return error instanceof SodViolationError ? 'deny' : 'other';
  }
}

describe('SoD parity: Cedar condition and service helper agree on every shared vector', () => {
  it.each(SOD_VECTORS)('$name', (vector) => {
    const expected = vector.same ? 'deny' : 'allow';
    expect(serviceDecision(vector)).toBe(expected);
    expect(cedarDecision(vector)).toBe(expected);
  });

  it('denies (fails closed) when the resource carries no requesterId', () => {
    const answer = isAuthorized({
      principal: { type: 'User', id: 'usr_a' },
      action: { type: 'Action', id: 'approve' },
      resource: { type: 'Doc', id: 'doc_1' },
      context: {},
      policies: { staticPolicies: POLICY },
      entities: [
        { uid: { type: 'User', id: 'usr_a' }, attrs: { id: 'usr_a' }, parents: [] },
        { uid: { type: 'Doc', id: 'doc_1' }, attrs: {}, parents: [] },
      ],
      schema,
      validateRequest: true,
    });
    expect(answer.type === 'failure' || answer.response.decision === 'deny').toBe(true);
  });

  it('exposes the condition the RBAC-004 and POLICY policies embed', () => {
    expect(sodCedarCondition()).toBe('resource.requesterId == principal.id');
  });
});
