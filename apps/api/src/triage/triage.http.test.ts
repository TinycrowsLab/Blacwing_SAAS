import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTenantContextOrThrow, type TenantPrincipal } from '@blackwing/db/tenant-context';
import { toPublicId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { memoryTriageStore, type MemoryTriageStore, SCORED } from './fixtures.test-helpers.js';
import { TriageModule } from './module.js';
import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  APPSEC_A,
  APPSEC_B,
  AUDITOR_A,
  DEV_A,
  NOROLE_A,
  TENANT_A,
  TENANT_B,
  findingRow,
  memoryFindingStore,
  memoryMemberships,
  uuidOf,
} from '../findings/fixtures.test-helpers.js';
import { createFindingMetrics } from '../findings/metrics.js';
import { FindingModule } from '../findings/module.js';
import { createCedarFindingPolicy } from '../findings/policy.js';
import { FindingService } from '../findings/service.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';
import { createCursorCodec } from '../pagination/index.js';

import type { FindingRow } from '@blackwing/db';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const USERS: Record<string, string> = {
  'appsec-a': APPSEC_A,
  'dev-a': DEV_A,
  'auditor-a': AUDITOR_A,
  'norole-a': NOROLE_A,
  'appsec-b': APPSEC_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };
const CURSOR_SECRET = 'c'.repeat(40);
const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });

/** Test IAM: the principal comes from a header the test controls, as `<user>@<tenant>` (for example `appsec-a@a`). */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

const ACTOR = 'appsec-a@a';
const KEY = (n: string) => `triage-key-${n}-0000`;
const RELEASE_BODY = { reason: 'Reproduced with a valid session' };
const FUTURE = '2099-01-01T00:00:00.000Z';

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let store: MemoryTriageStore;
/** Tenant A: a scored, confirmed finding; a second confirmed finding to mark as canonical; a released one; a suspected one; an unscored one. */
let confirmed: FindingRow;
let canonical: FindingRow;
let released: FindingRow;
let suspected: FindingRow;
let unscored: FindingRow;
/** Tenant B's confirmed finding: invisible to tenant A. */
let foreign: FindingRow;

beforeEach(async () => {
  metrics = createHttpMetrics();
  confirmed = findingRow(1, { severity: SCORED });
  canonical = findingRow(2, { severity: SCORED });
  released = findingRow(3, { status: 'released', severity: SCORED, stateVersion: 1 });
  suspected = findingRow(4, { status: 'suspected', severity: SCORED });
  unscored = findingRow(5);
  foreign = findingRow(6, { tenantId: TENANT_B, assetId: uuidOf(0xb1), severity: SCORED });
  const rows = [confirmed, canonical, released, suspected, unscored, foreign];
  const tenantOf = () => getTenantContextOrThrow().tenantId;
  const memberships = memoryMemberships({
    [TENANT_A]: {
      [APPSEC_A]: ['appsec_engineer'],
      [DEV_A]: ['developer'],
      [AUDITOR_A]: ['auditor'],
    },
    [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
  });
  store = memoryTriageStore(rows, tenantOf);
  const findingStore = memoryFindingStore(rows, [], tenantOf);
  // The decisions authorise through the same read service the finding routes use. Its counter lives on a private
  // registry, because FindingModule registers the same counter on the app's registry.
  const findings = new FindingService({
    store: findingStore,
    memberships,
    policy: createCedarFindingPolicy(),
    cursors: createCursorCodec(CURSOR_SECRET),
    metrics: createFindingMetrics(new Registry()),
    logger,
  });
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger,
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    idempotencyStore: new InMemoryIdempotencyStore(),
    imports: [
      FindingModule.forRoot({
        store: findingStore,
        memberships,
        logger,
        registry: metrics.registry,
        cursorSecret: CURSOR_SECRET,
      }),
      TriageModule.forRoot({ store, findings, memberships, logger, registry: metrics.registry }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const as = (who: string) => ({ 'x-test-principal': who });

interface DecisionOptions {
  readonly who?: string;
  readonly key?: string | undefined;
  readonly ifMatch?: string | undefined;
  readonly body?: unknown;
}

/** One `POST /v1/findings/{id}/{action}` call. Defaults: the analyst, a fresh key, `If-Match` of version 0. */
function decide(action: string, row: FindingRow, options: DecisionOptions = {}) {
  const headers: Record<string, string> = { ...as(options.who ?? ACTOR) };
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  return app.inject({
    method: 'POST',
    url: `/v1/findings/${row.publicId}/${action}`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: options.body === undefined ? {} : (options.body as object),
  });
}

/** The keyed, versioned call an analyst makes by default. */
const decideFresh = (action: string, row: FindingRow, body: unknown, n = '1') =>
  decide(action, row, { key: KEY(n), ifMatch: '"v0"', body });

interface Problem {
  readonly code: string;
  readonly status: number;
}

describe('POST /v1/findings/{id}/release', () => {
  it('releases a scored, evidenced confirmed finding, returns it with the new ETag and writes one audit event', async () => {
    const res = await decideFresh('release', confirmed, RELEASE_BODY);

    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ finding: { id: string; status: string; stateVersion: number } }>().finding,
    ).toMatchObject({
      id: confirmed.publicId,
      status: 'released',
      stateVersion: 1,
    });
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(store.audits).toEqual([
      expect.objectContaining({
        action: 'finding.released',
        findingId: confirmed.id,
        from: 'confirmed',
        to: 'released',
        actorId: APPSEC_A,
        tenantId: TENANT_A,
      }),
    ]);
  });

  it('answers the ETag of the finding GET, which is the If-Match the decision needs', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/v1/findings/${confirmed.publicId}`,
      headers: as(ACTOR),
    });
    expect(read.headers.etag).toBe('"v0"');

    const res = await decide('release', confirmed, {
      key: KEY('etag'),
      ifMatch: String(read.headers.etag),
      body: RELEASE_BODY,
    });
    expect(res.statusCode).toBe(200);
  });

  it('a stale If-Match is 412 TRIAGE_CONCURRENCY: a second decision on the same version loses and writes nothing', async () => {
    expect((await decideFresh('release', confirmed, RELEASE_BODY, '1')).statusCode).toBe(200);

    const loser = await decideFresh('release', confirmed, RELEASE_BODY, '2');

    expect(loser.statusCode).toBe(412);
    expect(loser.json<Problem>().code).toBe('triage_concurrency');
    expect(store.audits).toHaveLength(1);
  });

  it('a concurrent write the store wins is 412 TRIAGE_CONCURRENCY, not a second release', async () => {
    // The store sees a version the request did not read: its compare-and-set refuses the change.
    const realTransition = store.transition.bind(store);
    store.transition = async (tenantId, request) =>
      realTransition(tenantId, {
        ...request,
        expectedStateVersion: request.expectedStateVersion + 1,
      });

    const res = await decideFresh('release', confirmed, RELEASE_BODY);

    expect(res.statusCode).toBe(412);
    expect(res.json<Problem>().code).toBe('triage_concurrency');
    expect(store.audits).toHaveLength(0);
  });

  it('a missing If-Match is 428 and a weak one is 428: nothing is decided without the version', async () => {
    const missing = await decide('release', confirmed, { key: KEY('a'), body: RELEASE_BODY });
    const weak = await decide('release', confirmed, {
      key: KEY('b'),
      ifMatch: 'W/"v0"',
      body: RELEASE_BODY,
    });

    expect(missing.statusCode).toBe(428);
    expect(weak.statusCode).toBe(428);
    expect(store.calls).toHaveLength(0);
  });

  it('a missing Idempotency-Key is 400 idempotency_key_required', async () => {
    const res = await decide('release', confirmed, { ifMatch: '"v0"', body: RELEASE_BODY });

    expect(res.statusCode).toBe(400);
    expect(res.json<Problem>().code).toBe('idempotency_key_required');
    expect(store.calls).toHaveLength(0);
  });

  it('a replayed Idempotency-Key returns the first answer and does not transition the finding twice', async () => {
    const first = await decideFresh('release', confirmed, RELEASE_BODY, 'replay');
    const replay = await decideFresh('release', confirmed, RELEASE_BODY, 'replay');

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(store.calls).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it('the same Idempotency-Key with another body is 409 idempotency_conflict and runs nothing', async () => {
    await decideFresh('release', confirmed, RELEASE_BODY, 'reuse');
    const other = await decideFresh(
      'release',
      confirmed,
      { reason: 'a different reason' },
      'reuse',
    );

    expect(other.statusCode).toBe(409);
    expect(other.json<Problem>().code).toBe('idempotency_conflict');
    expect(store.calls).toHaveLength(1);
  });

  it('a finding with no scored severity is 409 TRIAGE_PRECONDITION_FAILED', async () => {
    const res = await decideFresh('release', unscored, RELEASE_BODY);

    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('triage_precondition_failed');
    expect(store.audits).toHaveLength(0);
  });

  it('a released finding cannot be released again: 409 TRIAGE_INVALID_TRANSITION', async () => {
    const res = await decide('release', released, {
      key: KEY('again'),
      ifMatch: '"v1"',
      body: RELEASE_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<Problem>().code).toBe('triage_invalid_transition');
    expect(store.audits).toHaveLength(0);
  });

  it('a release without a reason, or with a whitespace-only one, is 422 TRIAGE_REASON_REQUIRED', async () => {
    const none = await decideFresh('release', confirmed, {}, 'none');
    const blank = await decideFresh('release', confirmed, { reason: '   ' }, 'blank');

    expect(none.statusCode).toBe(422);
    expect(none.json<Problem>().code).toBe('triage_reason_required');
    expect(blank.statusCode).toBe(422);
    expect(blank.json<Problem>().code).toBe('triage_reason_required');
    expect(store.audits).toHaveLength(0);
  });

  it('an unknown body field is refused by the schema and changes nothing', async () => {
    const res = await decideFresh(
      'release',
      confirmed,
      { reason: 'ok', severity: 'none' },
      'extra',
    );

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('validation_failed');
    expect(store.calls).toHaveLength(0);
  });
});

describe('POST /v1/findings/{id}/reject', () => {
  it('rejects a confirmed finding as a false positive with its reason and an audit event', async () => {
    const res = await decideFresh('reject', confirmed, {
      reason: 'Not reachable from the internet',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ finding: { status: string } }>().finding.status).toBe(
      'rejected_false_positive',
    );
    expect(store.audits).toEqual([
      expect.objectContaining({ action: 'finding.rejected', to: 'rejected_false_positive' }),
    ]);
  });

  it('a whitespace-only reason is 422 TRIAGE_REASON_REQUIRED', async () => {
    const res = await decideFresh('reject', confirmed, { reason: ' \t ' });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_reason_required');
    expect(store.audits).toHaveLength(0);
  });

  it('a reject without a reason field is refused by the schema', async () => {
    const res = await decideFresh('reject', confirmed, {});

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('validation_failed');
  });
});

describe('POST /v1/findings/{id}/duplicate', () => {
  it('marks a finding a duplicate of a visible canonical finding of the same asset class', async () => {
    const res = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: canonical.publicId,
      reason: 'Same route, same parameter',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ finding: { status: string } }>().finding.status).toBe('duplicate');
    expect(store.row(confirmed.id)?.duplicateOf).toBe(canonical.id);
    expect(store.audits).toEqual([
      expect.objectContaining({ action: 'finding.marked_duplicate', to: 'duplicate' }),
    ]);
  });

  it('a canonical finding of another tenant is 422 TRIAGE_DUPLICATE_TARGET_INVALID, indistinguishable from a missing one', async () => {
    const other = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: foreign.publicId,
      reason: 'x',
    });
    const missing = await decideFresh(
      'duplicate',
      confirmed,
      {
        canonicalFindingId: toPublicId(uuidOf(0xdead), 'fnd'),
        reason: 'x',
      },
      '2',
    );

    expect(other.statusCode).toBe(422);
    expect(other.json<Problem>().code).toBe('triage_duplicate_target_invalid');
    expect(missing.statusCode).toBe(422);
    expect(missing.json<Problem>().code).toBe('triage_duplicate_target_invalid');
    expect(store.audits).toHaveLength(0);
  });

  it('a finding cannot be its own canonical finding: 422 TRIAGE_DUPLICATE_TARGET_INVALID', async () => {
    const res = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: confirmed.publicId,
      reason: 'x',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_duplicate_target_invalid');
  });

  it('a malformed canonical id is 422 TRIAGE_DUPLICATE_TARGET_INVALID', async () => {
    const res = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: 'not-a-finding-id',
      reason: 'x',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_duplicate_target_invalid');
  });

  it('a suspected finding cannot be the canonical finding: 422 TRIAGE_DUPLICATE_TARGET_INVALID', async () => {
    const res = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: suspected.publicId,
      reason: 'x',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_duplicate_target_invalid');
  });

  it('a duplicate without a reason is 422 TRIAGE_REASON_REQUIRED', async () => {
    const res = await decideFresh('duplicate', confirmed, {
      canonicalFindingId: canonical.publicId,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_reason_required');
  });
});

describe('POST /v1/findings/{id}/accept-risk', () => {
  it('accepts the risk until a future expiry, stored as canonical UTC', async () => {
    const res = await decideFresh('accept-risk', confirmed, {
      reason: 'Compensating control in place',
      expiry: '2099-06-01T12:00:00+02:00',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ finding: { status: string } }>().finding.status).toBe('accepted_risk');
    expect(store.row(confirmed.id)?.acceptedRisk).toEqual({
      reason: 'Compensating control in place',
      expiresAt: '2099-06-01T10:00:00.000Z',
    });
    expect(store.audits).toEqual([
      expect.objectContaining({ action: 'finding.risk_accepted', to: 'accepted_risk' }),
    ]);
  });

  it('a missing expiry is 422 TRIAGE_RISK_EXPIRY_INVALID', async () => {
    const res = await decideFresh('accept-risk', confirmed, { reason: 'Accepted' });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_risk_expiry_invalid');
    expect(store.audits).toHaveLength(0);
  });

  it('a past expiry is 422 TRIAGE_RISK_EXPIRY_INVALID', async () => {
    const res = await decideFresh('accept-risk', confirmed, {
      reason: 'Accepted',
      expiry: '2000-01-01T00:00:00.000Z',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_risk_expiry_invalid');
  });

  it('an expiry without an offset is 422 TRIAGE_RISK_EXPIRY_INVALID', async () => {
    const res = await decideFresh('accept-risk', confirmed, {
      reason: 'Accepted',
      expiry: '2099-01-01T00:00:00',
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_risk_expiry_invalid');
  });

  it('a whitespace-only reason is 422 TRIAGE_REASON_REQUIRED', async () => {
    const res = await decideFresh('accept-risk', confirmed, { reason: '  ', expiry: FUTURE });

    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('triage_reason_required');
  });
});

describe('who may decide', () => {
  it('a finding of another tenant is 404, the same as a missing one', async () => {
    const res = await decideFresh('release', confirmed, RELEASE_BODY);
    const foreignCall = await decide('release', confirmed, {
      who: 'appsec-b@b',
      key: KEY('foreign'),
      ifMatch: '"v0"',
      body: RELEASE_BODY,
    });
    const missingCall = await app.inject({
      method: 'POST',
      url: `/v1/findings/${toPublicId(uuidOf(0xdead), 'fnd')}/release`,
      headers: {
        ...as(ACTOR),
        'idempotency-key': KEY('gone'),
        'if-match': '"v0"',
        'content-type': 'application/json',
      },
      payload: RELEASE_BODY,
    });

    expect(res.statusCode).toBe(200);
    expect(foreignCall.statusCode).toBe(404);
    expect(missingCall.statusCode).toBe(404);
    expect(foreignCall.json<Problem>().code).toBe(missingCall.json<Problem>().code);
  });

  it('a Suspected finding is hidden from a developer (404) and is not confirmed for an analyst (409)', async () => {
    const dev = await decide('reject', suspected, {
      who: 'dev-a@a',
      key: KEY('dev'),
      ifMatch: '"v0"',
      body: { reason: 'x' },
    });
    const analyst = await decideFresh('reject', suspected, { reason: 'x' }, 'analyst');

    expect(dev.statusCode).toBe(404);
    expect(analyst.statusCode).toBe(409);
    expect(analyst.json<Problem>().code).toBe('triage_invalid_transition');
  });

  it('a developer who can read a finding but holds no triage permission is 403 and writes nothing', async () => {
    const res = await decide('release', confirmed, {
      who: 'dev-a@a',
      key: KEY('dev-triage'),
      ifMatch: '"v0"',
      body: RELEASE_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(store.calls).toHaveLength(0);
  });

  it('an auditor who reads findings cannot decide them: 403', async () => {
    const res = await decide('reject', confirmed, {
      who: 'auditor-a@a',
      key: KEY('auditor'),
      ifMatch: '"v0"',
      body: { reason: 'x' },
    });

    expect(res.statusCode).toBe(403);
    expect(store.calls).toHaveLength(0);
  });

  it('a user with no role in the tenant is 403', async () => {
    const res = await decide('release', confirmed, {
      who: 'norole-a@a',
      key: KEY('norole'),
      ifMatch: '"v0"',
      body: RELEASE_BODY,
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('triage metrics', () => {
  it('count each decision by action and result, without finding or user ids', async () => {
    await decideFresh('release', confirmed, RELEASE_BODY, 'm1');
    await decideFresh('release', confirmed, RELEASE_BODY, 'm2');

    const scrape = await metrics.registry.metrics();

    expect(scrape).toMatch(/triage_decision_total\{action="release",result="ok"\} 1/);
    expect(scrape).toMatch(/triage_decision_total\{action="release",result="conflict"\} 1/);
    expect(scrape).toMatch(/triage_decision_ms_count\{action="release"\} 2/);
    expect(scrape).not.toContain(confirmed.publicId);
  });
});
