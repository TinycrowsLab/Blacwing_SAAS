import {
  acceptRiskFindingSchema,
  duplicateFindingSchema,
  findingTriageResponseSchema,
  idempotencyKeySchema,
  rejectFindingSchema,
  releaseFindingSchema,
} from '@blackwing/contracts';

import {
  type JsonObject,
  jsonSchema,
  type OpenApiModule,
  registerSchema,
} from '../openapi/schema.js';

const BASE = '/v1/findings/{id}';

/** Session or bearer, as every tenant route (§9). */
const SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];

const ETAG_HEADER: JsonObject = {
  ETag: {
    description:
      'Strong validator of the finding after the decision. Send it in If-Match on the next decision.',
    schema: { type: 'string' },
  },
};

const IDEMPOTENCY_KEY_PARAM: JsonObject = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Replays of the same key return the first answer and run no second transition; reuse with another body is 409.',
  schema: jsonSchema(idempotencyKeySchema),
  example: 'triage-2026-10-31-release-1',
};

const IF_MATCH_PARAM: JsonObject = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description:
    'The ETag of the finding as the analyst read it (GET /v1/findings/{id}). A stale value answers 412 triage_concurrency, a missing or weak one 428.',
  schema: { type: 'string', minLength: 1 },
  example: '"v0"',
};

const ID_PARAM: JsonObject = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The `fnd_…` public id of the finding.',
  schema: { type: 'string', pattern: '^fnd_[A-Za-z0-9]+$' },
};

const problem = (description: string): JsonObject => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const EXAMPLE_FINDING = {
  id: 'fnd_01m64cavacexhrddgjb6xd80xv',
  title: 'Missing authorisation on /admin',
  class: 'broken_access_control',
  status: 'released',
  baselineStatus: 'new',
  severity: {
    cvss4: {
      vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
      score: 8.7,
      severity: 'high',
      nomenclature: 'CVSS-B',
    },
  },
  cweId: 'CWE-285',
  owaspCategory: 'A01',
  unmapped: false,
  confidence: 0.9,
  assetId: '0198f0a0-0000-7000-8000-0000000000e1',
  location: { method: 'GET', urlTemplate: '/admin', parameter: null, file: null, line: null },
  firstSeenRunId: '0198f0a0-0000-7000-8000-0000000000c1',
  lastSeenRunId: '0198f0a0-0000-7000-8000-0000000000c1',
  stateVersion: 2,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-31T09:00:00.000Z',
};

/** One Gate 3 decision route: its body, its refusals and its answer. */
function decision(summary: string, description: string, bodySchema: string): JsonObject {
  return {
    post: {
      operationId: summary,
      tags: ['triage'],
      summary,
      description,
      security: SECURITY,
      parameters: [ID_PARAM, IDEMPOTENCY_KEY_PARAM, IF_MATCH_PARAM],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${bodySchema}` } } },
      },
      responses: {
        '200': {
          description: 'The finding after the decision, and its new ETag.',
          headers: ETAG_HEADER,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/FindingTriage' },
              examples: {
                current: { summary: 'A released finding', value: { finding: EXAMPLE_FINDING } },
              },
            },
          },
        },
        '400': problem('No Idempotency-Key header (idempotency_key_required).'),
        '401': problem('No valid credential.'),
        '403': problem(
          'The caller lacks finding:read or finding:triage in this tenant (permission_denied).',
        ),
        '404': problem('Unknown, foreign or hidden finding (not_found).'),
        '409': problem(
          'Decision refused with the finding as it is: triage_invalid_transition, triage_precondition_failed, idempotency_conflict or idempotency_in_progress.',
        ),
        '412': problem(
          'If-Match is no longer the current ETag (triage_concurrency). Re-read the finding and decide again.',
        ),
        '422': problem(
          'A refused input: validation_failed, triage_reason_required, triage_risk_expiry_invalid or triage_duplicate_target_invalid.',
        ),
        '428': problem('No usable If-Match header (precondition_required).'),
      },
    },
  };
}

/**
 * Gate 3 decisions (TRIAGE-004 over TRIAGE-001): release, reject, mark duplicate and accept the risk of a Confirmed
 * finding. Each carries an Idempotency-Key and the finding's ETag, and answers the finding after the change.
 */
export function triageOpenApiModule(): OpenApiModule {
  const schemas: JsonObject = {};
  registerSchema(schemas, 'ReleaseFinding', releaseFindingSchema);
  registerSchema(schemas, 'RejectFinding', rejectFindingSchema);
  registerSchema(schemas, 'DuplicateFinding', duplicateFindingSchema);
  registerSchema(schemas, 'AcceptRiskFinding', acceptRiskFindingSchema);
  registerSchema(schemas, 'FindingTriage', findingTriageResponseSchema);
  return {
    tag: 'triage',
    description:
      'Gate 3 triage (TRIAGE-001, TRIAGE-004): an analyst releases, rejects, marks a duplicate or accepts the risk of a Confirmed finding. Every decision needs a reason, the finding ETag and an Idempotency-Key.',
    paths: {
      [`${BASE}/release`]: decision(
        'releaseFinding',
        'Moves a Confirmed finding to released. Needs a scored severity and bound evidence, and a reason. Needs finding:triage.',
        'ReleaseFinding',
      ),
      [`${BASE}/reject`]: decision(
        'rejectFinding',
        'Moves a Confirmed finding to rejected_false_positive, with the reason. Needs finding:triage.',
        'RejectFinding',
      ),
      [`${BASE}/duplicate`]: decision(
        'markFindingDuplicate',
        'Moves a Confirmed finding to duplicate of a canonical finding (`canonicalFindingId`, a visible finding of the same asset class that is not itself a duplicate). Needs finding:triage.',
        'DuplicateFinding',
      ),
      [`${BASE}/accept-risk`]: decision(
        'acceptFindingRisk',
        'Moves a Confirmed finding to accepted_risk until `expiry` (an ISO-8601 instant with an offset, in the future), with the reason. Needs finding:triage.',
        'AcceptRiskFinding',
      ),
    },
    schemas,
  };
}
