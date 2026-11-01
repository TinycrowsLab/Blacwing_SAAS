import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isUuidV7, newId, type Uuid } from '@blackwing/ids';

import { buildEvalTenantSeedPlan, type EvalSeedTarget, evalTenantRow } from './eval-plan.js';
import { loadEvalSeedTargets, EVAL_TARGETS_DIR } from './eval-targets.js';
import { PERSONA_KEYS, type PersonaKey, SEED_LAB_CIDR, tenantRow } from './plan.js';

import type { IsoTimestamp } from '@blackwing/time';

const NOW = '2026-10-20T12:00:00.000Z' as IsoTimestamp;
const tenantId = newId();
const userIds = Object.fromEntries(PERSONA_KEYS.map((k) => [k, newId()])) as Record<
  PersonaKey,
  Uuid
>;

const JUICE: EvalSeedTarget = {
  name: 'juice-shop',
  title: 'Juice Shop',
  assetType: 'web_app',
  service: 'juice-shop',
  port: 3000,
};
const VAMPI: EvalSeedTarget = {
  name: 'vampi',
  title: 'VAmPI',
  assetType: 'api',
  service: 'vampi',
  port: 5000,
};
const BOLA: EvalSeedTarget = {
  name: 'bola-api',
  title: 'BOLA lab',
  assetType: 'api',
  service: 'bola-api',
  port: 8080,
};
const TARGETS: EvalSeedTarget[] = [JUICE, VAMPI, BOLA];

const build = (over: Partial<Parameters<typeof buildEvalTenantSeedPlan>[0]> = {}) =>
  buildEvalTenantSeedPlan({ now: NOW, tenantId, userIds, targets: TARGETS, ...over });

describe('eval tenant row', () => {
  it('is its own tenant, distinct from the demo tenant acme', () => {
    expect(evalTenantRow(NOW)).toMatchObject({ slug: 'eval', status: 'active', plan: 'dev' });
    expect(evalTenantRow(NOW).id).not.toBe(tenantRow(NOW).id);
    expect(isUuidV7(evalTenantRow(NOW).id)).toBe(true);
  });
});

describe('buildEvalTenantSeedPlan (EVAL-001)', () => {
  it('writes one verified dev asset per target, addressed on the lab network, never loopback', () => {
    const plan = build();
    expect(plan.assets.map((a) => a.name)).toEqual([
      'Juice Shop (eval lab)',
      'VAmPI (eval lab)',
      'BOLA lab (eval lab)',
    ]);
    for (const asset of plan.assets) {
      expect(asset).toMatchObject({
        environment: 'dev',
        verificationStatus: 'verified',
        verificationMethod: 'manual_letter',
        ownerUserId: userIds.owner,
      });
      expect(JSON.stringify(asset.identifiers)).not.toMatch(/127\.0\.0\.1|localhost/);
    }
    expect(plan.assets[1]?.identifiers).toEqual([{ kind: 'url', value: 'http://vampi:5000' }]);
    expect(plan.assets[1]?.type).toBe('api');
  });

  it('issues one active, unexpired SA over every target at active_safe, with separation of duties', () => {
    const plan = build();
    const sa = plan.standingAuthorisation;
    expect(sa).toMatchObject({
      status: 'active',
      maxIntrusiveness: 'active_safe',
      assetIds: plan.assets.map((a) => a.id),
      requesterId: userIds.appsec,
      approverId: userIds.owner,
    });
    expect(sa.requesterId).not.toBe(sa.approverId);
    expect(sa.preApprovedTestClasses).toEqual(['passive', 'active_safe']);
    expect(Date.parse(sa.expiresAt)).toBeGreaterThan(Date.parse(NOW));
    expect(sa.signingKeyId).toMatch(/^dev-seed-/);
  });

  it('scopes each target to its own host and port, plus the lab range on that port only', () => {
    const plan = build();
    const rules = plan.standingAuthorisation.scopeRules.rules;
    expect(rules).toEqual([
      expect.objectContaining({ effect: 'include', host: 'juice-shop', ports: [3000] }),
      expect.objectContaining({ effect: 'include', cidr: SEED_LAB_CIDR, ports: [3000] }),
      expect.objectContaining({ effect: 'include', host: 'vampi', ports: [5000] }),
      expect.objectContaining({ effect: 'include', cidr: SEED_LAB_CIDR, ports: [5000] }),
      expect.objectContaining({ effect: 'include', host: 'bola-api', ports: [8080] }),
      expect.objectContaining({ effect: 'include', cidr: SEED_LAB_CIDR, ports: [8080] }),
    ]);
    expect(plan.labScope).toEqual({ privateRuleCount: 3, labNetworks: [SEED_LAB_CIDR] });
  });

  it('seeds only the requester and approver as members of the eval tenant', () => {
    const plan = build();
    expect(plan.memberships).toEqual([
      { userId: userIds.appsec, roles: ['appsec_engineer'] },
      { userId: userIds.owner, roles: ['asset_owner'] },
    ]);
  });

  it('refuses an empty target list, duplicate target names and requester == approver', () => {
    expect(() => build({ targets: [] })).toThrow(/at least one target/);
    expect(() => build({ targets: [JUICE, JUICE] })).toThrow(/must be unique/);
    expect(() => build({ targets: TARGETS })).not.toThrow();
    const sameUser = { ...userIds, owner: userIds.appsec };
    expect(() => build({ userIds: sameUser })).toThrow(/approver must not be the requester/);
  });

  it('fails closed when the lab range is not a private range (the lab gate, #880)', () => {
    expect(() => build({ labCidr: '203.0.113.0/24' })).toThrow();
  });
});

describe('loadEvalSeedTargets', () => {
  it('loads every committed manifest, validated against the shared schema', () => {
    const targets = loadEvalSeedTargets(EVAL_TARGETS_DIR);
    expect(targets.map((t) => t.name).sort()).toEqual([
      'bola-api',
      'crapi',
      'dvga',
      'dvwa',
      'juice-shop',
      'ssrf-lab',
      'vampi',
      'webgoat',
    ]);
    expect(targets.find((t) => t.name === 'crapi')).toMatchObject({ service: 'crapi', port: 80 });
  });

  it('refuses a manifest that fails the schema, and two manifests with one name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-targets-'));
    const sub = path.join(dir, 'one');
    mkdirSync(sub);
    writeFileSync(path.join(sub, 'target.json'), JSON.stringify({ name: 'broken' }));
    expect(() => loadEvalSeedTargets(dir)).toThrow();
    const good: unknown = JSON.parse(
      readFileSync(path.join(EVAL_TARGETS_DIR, 'vampi', 'target.json'), 'utf8'),
    );
    writeFileSync(path.join(sub, 'target.json'), JSON.stringify(good));
    const twin = path.join(dir, 'two');
    mkdirSync(twin);
    writeFileSync(path.join(twin, 'target.json'), JSON.stringify(good));
    expect(() => loadEvalSeedTargets(dir)).toThrow(/duplicate target names/);
  });
});
