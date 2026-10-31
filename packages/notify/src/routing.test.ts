import { describe, expect, it } from 'vitest';

import { matchRoutes, type RouteRule, ruleRecipients } from './routing.js';

const RULE_A = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8d01';
const RULE_B = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8d02';
const RULE_C = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8d03';
const ASSET = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8e01';
const OTHER_ASSET = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8e02';
const CHANNEL = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8c01';

function rule(overrides: Partial<RouteRule> & Pick<RouteRule, 'id'>): RouteRule {
  return {
    event: '*',
    assetId: null,
    severityMin: 'info',
    channelId: CHANNEL,
    recipientSpec: {},
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

const ids = (rules: readonly { rule: RouteRule }[]) => rules.map((match) => match.rule.id);

describe('matchRoutes', () => {
  it('matches the rules whose event is the request event or the wildcard', () => {
    const rules = [
      rule({ id: RULE_A, event: 'kill.fired' }),
      rule({ id: RULE_B, event: '*' }),
      rule({ id: RULE_C, event: 'run.failed' }),
    ];
    const matched = matchRoutes({ event: 'kill.fired', severity: 'critical' }, rules);
    expect(ids(matched)).toEqual([RULE_A, RULE_B]);
  });

  it('never matches a disabled rule', () => {
    const rules = [rule({ id: RULE_A, enabled: false })];
    expect(matchRoutes({ event: 'run.completed', severity: 'info' }, rules)).toEqual([]);
  });

  it('applies the minimum severity: a critical-only rule ignores a high notice', () => {
    const rules = [rule({ id: RULE_A, severityMin: 'critical' })];
    expect(matchRoutes({ event: 'kill.fired', severity: 'high' }, rules)).toEqual([]);
    expect(ids(matchRoutes({ event: 'kill.fired', severity: 'critical' }, rules))).toEqual([
      RULE_A,
    ]);
  });

  it('lets an asset-specific rule override the wildcard-asset rules for that asset', () => {
    const rules = [
      rule({ id: RULE_A, assetId: ASSET, channelId: CHANNEL }),
      rule({ id: RULE_B, assetId: null, channelId: CHANNEL }),
    ];
    const matched = matchRoutes({ event: 'run.failed', assetId: ASSET, severity: 'high' }, rules);
    expect(ids(matched)).toEqual([RULE_A]);
  });

  it('keeps the wildcard-asset rules when no asset-specific rule names the asset', () => {
    const rules = [rule({ id: RULE_A, assetId: OTHER_ASSET }), rule({ id: RULE_B, assetId: null })];
    const matched = matchRoutes({ event: 'run.failed', assetId: ASSET, severity: 'high' }, rules);
    expect(ids(matched)).toEqual([RULE_B]);
  });

  it('applies a wildcard-asset rule to a request that names no asset', () => {
    const rules = [rule({ id: RULE_A, assetId: ASSET }), rule({ id: RULE_B, assetId: null })];
    expect(ids(matchRoutes({ event: 'run.failed', severity: 'high' }, rules))).toEqual([RULE_B]);
  });

  it('orders by specificity, then priority (higher first), then id, and the order is deterministic', () => {
    const rules = [
      rule({ id: RULE_C, event: '*', assetId: null, priority: 100 }),
      rule({ id: RULE_B, event: 'kill.fired', assetId: null, priority: 1 }),
      rule({ id: RULE_A, event: 'kill.fired', assetId: null, priority: 5 }),
    ];
    const first = ids(matchRoutes({ event: 'kill.fired', severity: 'critical' }, rules));
    const second = ids(
      matchRoutes({ event: 'kill.fired', severity: 'critical' }, [...rules].reverse()),
    );
    expect(first).toEqual([RULE_A, RULE_B, RULE_C]);
    expect(second).toEqual(first);
  });

  it('breaks an exact tie by rule id', () => {
    const rules = [rule({ id: RULE_B, priority: 3 }), rule({ id: RULE_A, priority: 3 })];
    expect(ids(matchRoutes({ event: 'run.completed', severity: 'info' }, rules))).toEqual([
      RULE_A,
      RULE_B,
    ]);
  });
});

describe('ruleRecipients', () => {
  it('returns undefined when the rule names nobody, so the channel audience applies', () => {
    expect(ruleRecipients({}, { soc: ['soc@example.com'] })).toBeUndefined();
  });

  it('returns undefined when the named group has no members', () => {
    expect(ruleRecipients({ onCallGroup: 'soc' }, {})).toBeUndefined();
  });

  it('combines listed addresses and group members, lower-cased and de-duplicated', () => {
    const recipients = ruleRecipients(
      { emails: ['Lead@Example.com'], onCallGroup: 'soc' },
      { soc: ['lead@example.com', 'analyst@example.com'] },
    );
    expect(recipients).toEqual(['lead@example.com', 'analyst@example.com']);
  });
});
