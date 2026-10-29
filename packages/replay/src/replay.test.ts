import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';
import { ScopeViolationError, ValidationError } from '@blackwing/errors';

import { buildJuiceShopSqliPlan, JUICE_SHOP_LAB_ORIGIN } from './juice-shop-sqli.js';
import { bodyDigest, type ObservedResponse } from './oracle.js';
import { type Fetcher, type ReplayPlan, replayFinding } from './replay.js';

const recorded = (name: string): string =>
  readFileSync(new URL(`./fixtures/juice-shop-17.1.1/${name}`, import.meta.url), 'utf8');

/** The pinned lab's recorded responses: the broken-quote probe (500) and the ordinary control (200). */
const PROBE: ObservedResponse = { status: 500, body: recorded('probe-500.body.txt') };
const CONTROL: ObservedResponse = { status: 200, body: recorded('control-200.body.txt') };

/** A fetcher that answers by URL: the probe query gets `probe`, the control query gets `control`. */
function fetcherFor(responses: {
  probe: ObservedResponse | (() => ObservedResponse);
  control: ObservedResponse;
}): Fetcher & ReturnType<typeof vi.fn> {
  const fn = vi.fn<Fetcher>((url: string) => {
    const probeUrl = buildJuiceShopSqliPlan(JUICE_SHOP_LAB_ORIGIN).probeUrl;
    if (url === probeUrl) {
      return Promise.resolve(
        typeof responses.probe === 'function' ? responses.probe() : responses.probe,
      );
    }
    return Promise.resolve(responses.control);
  });
  return fn as Fetcher & ReturnType<typeof vi.fn>;
}

const plan = (overrides: Partial<ReplayPlan> = {}): ReplayPlan => ({
  ...buildJuiceShopSqliPlan(JUICE_SHOP_LAB_ORIGIN),
  ...overrides,
});

describe('replayFinding', () => {
  it('confirms when the probe reproduces twice and the negative control stays clean', async () => {
    const fetch = fetcherFor({ probe: PROBE, control: CONTROL });
    const result = await replayFinding(plan(), fetch);

    expect(result.outcome).toBe('confirmed');
    expect(result.reasons).toEqual([]);
    expect(result.testCaseId).toBe('webapi.injection.sql');
    expect(result.oracleId).toBe('oracle.webapi.injection.sql.error_signature.v1');
    expect(result.probe).toHaveLength(2);
    expect(
      result.probe.every((exchange) => exchange.matched && exchange.signature === 'SQLITE_ERROR'),
    ).toBe(true);
    expect(result.negativeControl?.matched).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('records a body digest, never the body, in the evidence', async () => {
    const result = await replayFinding(plan(), fetcherFor({ probe: PROBE, control: CONTROL }));

    expect(result.probe[0]?.bodySha256).toBe(bodyDigest(PROBE.body));
    expect(result.negativeControl?.bodySha256).toBe(bodyDigest(CONTROL.body));
    expect(JSON.stringify(result)).not.toContain('Apple Pomace');
    expect(JSON.stringify(result)).not.toContain('<html>');
  });

  it('keeps the pinned lab image in the result so the target build is recorded', async () => {
    const result = await replayFinding(plan(), fetcherFor({ probe: PROBE, control: CONTROL }));
    expect(result.labImage).toMatch(/^bkimminich\/juice-shop:v17\.1\.1@sha256:[0-9a-f]{64}$/);
  });

  it('is suspected when the negative control also trips the oracle', async () => {
    const triggering: ObservedResponse = { status: 500, body: 'SQLITE_ERROR for every term' };
    const result = await replayFinding(plan(), fetcherFor({ probe: PROBE, control: triggering }));

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['negative_control_triggered']);
  });

  it('is suspected when a single probe run does not reproduce the oracle', async () => {
    const answers: ObservedResponse[] = [
      PROBE,
      { status: 200, body: '{"status":"success","data":[]}' },
    ];
    const result = await replayFinding(
      plan(),
      fetcherFor({ probe: () => answers.shift() ?? PROBE, control: CONTROL }),
    );

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['probe_not_reproduced']);
  });

  it('is suspected, not confirmed, when a 200 echoes the signature (status is part of the oracle)', async () => {
    const echo: ObservedResponse = {
      status: 200,
      body: 'SQLITE_ERROR text in a product description',
    };
    const result = await replayFinding(plan(), fetcherFor({ probe: echo, control: CONTROL }));

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['probe_not_reproduced']);
  });

  it('is suspected on a transport failure and never confirms without a full exchange', async () => {
    const fetch = vi.fn<Fetcher>(() => Promise.reject(new TypeError('fetch failed')));
    const result = await replayFinding(plan(), fetch);

    expect(result.outcome).toBe('suspected');
    expect(result.reasons).toEqual(['transport_error']);
    expect(result.probe).toEqual([]);
    expect(result.negativeControl).toBeUndefined();
  });

  it('refuses to run a replay of fewer than two runs', async () => {
    const fetch = fetcherFor({ probe: PROBE, control: CONTROL });
    await expect(replayFinding(plan({ runs: 1 }), fetch)).rejects.toThrow(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a non-lab target before any traffic is sent', async () => {
    const fetch = fetcherFor({ probe: PROBE, control: CONTROL });
    const offLab = buildJuiceShopSqliPlan('http://203.0.113.10:13000');

    await expect(replayFinding(offLab, fetch)).rejects.toThrow(ScopeViolationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses when the negative control URL is out of scope, even if the probe URL is in scope', async () => {
    const fetch = fetcherFor({ probe: PROBE, control: CONTROL });
    const mixed = plan({
      negativeControlUrl: 'http://127.0.0.1:13000/rest/admin/application-version',
    });

    await expect(replayFinding(mixed, fetch)).rejects.toThrow(ScopeViolationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a plan whose scope excludes the lab entirely (default deny)', async () => {
    const fetch = fetcherFor({ probe: PROBE, control: CONTROL });
    await expect(
      replayFinding(plan({ scope: parseScopeRules({ rules: [] }) }), fetch),
    ).rejects.toThrow(ScopeViolationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
