import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  DNS_CHALLENGE_LABEL,
  expectedLocationOf,
  HTTP_CHALLENGE_PATH,
  hostOf,
  methodAppliesToAssetType,
} from './location.js';

describe('expectedLocationOf', () => {
  it('places a DNS challenge under the challenge label of the host', () => {
    expect(
      expectedLocationOf('dns_txt', [{ kind: 'url', value: 'https://portal.example.com/' }]),
    ).toBe(`${DNS_CHALLENGE_LABEL}.portal.example.com`);
  });

  it('places an HTTP challenge at the well-known path on the host, over https', () => {
    expect(expectedLocationOf('http_file', [{ kind: 'host', value: 'example.com' }])).toBe(
      `https://example.com${HTTP_CHALLENGE_PATH}`,
    );
  });

  it('has no probe location for a manual letter', () => {
    expect(expectedLocationOf('manual_letter', [{ kind: 'cidr', value: '10.0.0.0/8' }])).toBeNull();
  });

  it('refuses a host-based method for an asset with no host (422, no value echoed)', () => {
    expect(() => expectedLocationOf('dns_txt', [{ kind: 'cidr', value: '10.0.0.0/8' }])).toThrow(
      ValidationError,
    );
    expect(() => expectedLocationOf('http_file', [{ kind: 'repo', value: 'acme/app' }])).toThrow(
      /needs a host or url identifier/,
    );
  });
});

describe('methodAppliesToAssetType', () => {
  it('lets the HTTP-file method prove web and API assets only', () => {
    expect(methodAppliesToAssetType('http_file', 'web_app')).toBe(true);
    expect(methodAppliesToAssetType('http_file', 'api')).toBe(true);
    for (const type of ['host', 'network_range', 'source_repo'] as const) {
      expect(methodAppliesToAssetType('http_file', type)).toBe(false);
    }
  });

  it('lets the DNS and manual methods apply to every asset type', () => {
    for (const type of ['web_app', 'api', 'host', 'network_range', 'source_repo'] as const) {
      expect(methodAppliesToAssetType('dns_txt', type)).toBe(true);
      expect(methodAppliesToAssetType('manual_letter', type)).toBe(true);
    }
  });
});

describe('hostOf', () => {
  it('takes the first host-bearing identifier, in order', () => {
    expect(
      hostOf([
        { kind: 'cidr', value: '10.0.0.0/8' },
        { kind: 'url', value: 'https://a.example.com/x' },
        { kind: 'host', value: 'b.example.com' },
      ]),
    ).toBe('a.example.com');
  });

  it('is undefined when no identifier carries a host', () => {
    expect(hostOf([{ kind: 'repo', value: 'acme/app' }])).toBeUndefined();
  });
});
