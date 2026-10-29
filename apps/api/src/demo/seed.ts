// DEMO-STORY seed, run once at API boot in demo mode (idempotent). It makes sure the lab asset exists with
// ownership verified by lab trust, and that one finished run exists as a fallback for the story: if the live
// run fails on stage, the presenter can still open a complete finding. The fallback evidence is a recorded
// response from an earlier probe of the same lab image; it is marked `recorded: true` everywhere it is shown.
import { DEMO_TEST_CASE } from './catalogue.js';
import { fingerprintFor } from './service.js';

import type { DemoStore } from './store.js';

export const DEMO_ASSET_ID = '0197a5d0-0000-7000-8000-00000000a001';
export const DEMO_FALLBACK_REQUEST_ID = '0197a5d0-0000-7000-8000-00000000b001';
export const DEMO_FALLBACK_RUN_ID = '0197a5d0-0000-7000-8000-00000000c001';
export const DEMO_FALLBACK_FINDING_ID = '0197a5d0-0000-7000-8000-00000000d001';

export interface SeedActors {
  readonly requesterId: string;
  readonly approverId: string;
}

export interface SeedLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Same encoding as the runner: a single quote becomes %27 so the repro works in a shell. */
const encodeProbe = (value: string): string => encodeURIComponent(value).replace(/'/g, '%27');

const RECORDED_PROBE_BODY =
  '<html><head><title>Error: SQLITE_ERROR: near &quot;&#39;%&#39;&quot;: syntax error</title></head>' +
  '<body>(recorded excerpt from an earlier probe of the pinned lab image)</body></html>';

export async function seedDemoStory(
  store: DemoStore,
  tenantId: string,
  targetBaseUrl: string,
  actors: SeedActors | null,
  logger: SeedLogger,
): Promise<void> {
  await store.upsertAsset({
    id: DEMO_ASSET_ID,
    tenant_id: tenantId,
    slug: 'juice-shop',
    name: 'OWASP Juice Shop (lab)',
    base_url: targetBaseUrl,
    ownership_status: 'verified',
    verification_method: 'lab_trust',
  });
  logger.info({ event: 'demo.seed.asset', asset: 'juice-shop' }, 'demo asset ready');
  if (actors === null) {
    logger.warn({ event: 'demo.seed.skipped' }, 'demo users missing; fallback run not seeded');
    return;
  }
  if ((await store.countFinishedRunsForAsset(tenantId, DEMO_ASSET_ID)) > 0) return;

  const scope = { method: 'GET', host: new URL(targetBaseUrl).hostname, pathPrefix: '/rest/products/search', parameter: 'q' };
  const finding = {
    fingerprint: fingerprintFor([DEMO_TEST_CASE.id, DEMO_ASSET_ID, 'GET', '/rest/products/search', 'q', DEMO_FALLBACK_RUN_ID]),
    scope,
  };
  const probeUrl = `${targetBaseUrl}/rest/products/search?q=${encodeProbe(DEMO_TEST_CASE.probe.value)}`;
  const controlUrl = `${targetBaseUrl}/rest/products/search?q=${encodeProbe(DEMO_TEST_CASE.negativeControl.value)}`;
  await store.insertRequest({
    id: DEMO_FALLBACK_REQUEST_ID,
    tenant_id: tenantId,
    asset_id: DEMO_ASSET_ID,
    requester_id: actors.requesterId,
    test_case_id: DEMO_TEST_CASE.id,
    scope,
    intrusiveness: 'active_safe',
    budget_requests: 8,
    budget_seconds: 300,
    status: 'completed',
    approver_id: actors.approverId,
  });
  const pins = {
    asset: { id: DEMO_ASSET_ID, slug: 'juice-shop', name: 'OWASP Juice Shop (lab)', baseUrl: targetBaseUrl, ownership: { status: 'verified', method: 'lab_trust' } },
    scope,
    testCase: DEMO_TEST_CASE,
    runner: { name: 'demo-replay', version: '1' },
    fallback: true,
  };
  await store.insertRun({
    id: DEMO_FALLBACK_RUN_ID,
    tenant_id: tenantId,
    request_id: DEMO_FALLBACK_REQUEST_ID,
    created_by: actors.requesterId,
    pins,
    budget_requests: 8,
    state: 'completed',
    requests_used: 4,
  });
  const events = [
    ['run.queued', 'queued', 'Run accepted. Pins recorded: test case, oracle, runner version and lab target.'],
    ['scope.checked', 'scope', 'Scope checked: GET /rest/products/search on the verified lab asset.'],
    ['plan.selected', 'plan', `Planner selected ${DEMO_TEST_CASE.id} (deterministic stub).`],
    ['probe.sent', 'probe', 'Detection probe sent (benign syntax-breaking value).'],
    ['oracle.matched', 'validate', `Oracle ${DEMO_TEST_CASE.oracle.id} matched on replay 1 and replay 2.`],
    ['control.clean', 'validate', 'Negative control did not match the oracle.'],
    ['finding.confirmed', 'report', 'Finding confirmed by deterministic replay (fallback, recorded).'],
    ['run.completed', 'done', 'Run completed.'],
  ] as const;
  for (const [index, [kind, stage, message]] of events.entries()) {
    await store.appendEvent(DEMO_FALLBACK_RUN_ID, index + 1, { kind, stage, message, data: { fallback: true } });
  }
  await store.insertFinding({
    id: DEMO_FALLBACK_FINDING_ID,
    tenant_id: tenantId,
    run_id: DEMO_FALLBACK_RUN_ID,
    asset_id: DEMO_ASSET_ID,
    fingerprint: finding.fingerprint,
    title: `${DEMO_TEST_CASE.title} (GET /rest/products/search, parameter q)`,
    test_case_id: DEMO_TEST_CASE.id,
    class: 'injection.sqli',
    cwe_id: DEMO_TEST_CASE.cwe,
    owasp_category: DEMO_TEST_CASE.owasp,
    severity: { cvssV4Vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N', cvssV4Score: 8.7, cvssV31Vector: null },
    location: { method: 'GET', urlTemplate: '/rest/products/search', parameter: 'q', file: null, line: null },
    confidence: 0.95,
    oracle: { ...DEMO_TEST_CASE.oracle, bindingType: DEMO_TEST_CASE.oracle.type },
    evidence: {
      recorded: true,
      probe: { request: { method: 'GET', url: probeUrl }, response: { status: 500, bodyExcerpt: RECORDED_PROBE_BODY } },
      negativeControl: { request: { method: 'GET', url: controlUrl }, response: { status: 200 } },
    },
    replay: {
      reproduced: true,
      replays: [
        { n: 1, status: 500, matched: true },
        { n: 2, status: 500, matched: true },
      ],
      negativeControl: { status: 200, matched: false },
    },
    repro_curl: `curl -s -i '${probeUrl}'`,
  });
  logger.info({ event: 'demo.seed.fallback_run' }, 'fallback finished run seeded');
}
