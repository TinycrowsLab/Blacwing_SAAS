import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';

import { normaliseIdentifiers } from './identifiers.js';

import type { AssetIdentifierInput } from '@blackwing/contracts';

const one = (kind: AssetIdentifierInput['kind'], value: string) => [{ kind, value }];

function captureError(run: () => unknown): AppError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not-app-error';
  }
}

describe('normaliseIdentifiers: host assets', () => {
  it('lowercases a hostname and drops the trailing dot', () => {
    const result = normaliseIdentifiers('host', one('host', 'App.Example.COM.'));
    expect(result.identifiers).toEqual([{ kind: 'host', value: 'app.example.com' }]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts an IP literal as a host', () => {
    expect(normaliseIdentifiers('host', one('host', '10.0.0.5')).identifiers[0]?.value).toBe(
      '10.0.0.5',
    );
    expect(normaliseIdentifiers('host', one('host', '2001:DB8::1')).identifiers[0]?.value).toBe(
      '2001:db8::1',
    );
  });

  it('refuses a hostname with an illegal label, an empty label or a port', () => {
    for (const bad of [
      'bad_host.example.com',
      'a..b.example',
      'example.com:8443',
      '*.example.com',
    ]) {
      expect(codeOf(() => normaliseIdentifiers('host', one('host', bad)))).toBe(
        'ASSET_INVALID_IDENTIFIER',
      );
    }
  });

  it('refuses a hostname longer than 253 characters', () => {
    const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example`;
    expect(codeOf(() => normaliseIdentifiers('host', one('host', long)))).toBe(
      'ASSET_INVALID_IDENTIFIER',
    );
  });
});

describe('normaliseIdentifiers: URL assets', () => {
  it('canonicalises a web URL: lowercase host, default port and fragment dropped, root path', () => {
    const { identifiers } = normaliseIdentifiers(
      'web_app',
      one('url', 'HTTPS://Portal.Example.com:443#top'),
    );
    expect(identifiers).toEqual([{ kind: 'url', value: 'https://portal.example.com/' }]);
  });

  it('keeps the path and query of an API URL', () => {
    const { identifiers } = normaliseIdentifiers(
      'api',
      one('url', 'http://api.example.com:8080/v1?x=1'),
    );
    expect(identifiers[0]?.value).toBe('http://api.example.com:8080/v1?x=1');
  });

  it('refuses a URL that embeds credentials, and never echoes them back', () => {
    const secret = 'hunter2-SECRET';
    const error = captureError(() =>
      normaliseIdentifiers('web_app', one('url', `https://admin:${secret}@portal.example.com/`)),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error?.code).toBe('ASSET_INVALID_IDENTIFIER');
    expect(error?.message).not.toContain(secret);
    expect(error?.detail ?? '').not.toContain(secret);
    expect(
      codeOf(() => normaliseIdentifiers('web_app', one('url', `https://u:${secret}@h.example`))),
    ).toBe('ASSET_INVALID_IDENTIFIER');
  });

  it('refuses a non-HTTP scheme, a relative URL and a URL without a host', () => {
    expect(
      codeOf(() => normaliseIdentifiers('web_app', one('url', 'ftp://files.example.com'))),
    ).toBe('ASSET_INVALID_IDENTIFIER');
    expect(codeOf(() => normaliseIdentifiers('web_app', one('url', '/relative/path')))).toBe(
      'ASSET_INVALID_IDENTIFIER',
    );
    expect(codeOf(() => normaliseIdentifiers('web_app', one('url', 'https://')))).toBe(
      'ASSET_INVALID_IDENTIFIER',
    );
  });
});

describe('normaliseIdentifiers: CIDR assets', () => {
  it('masks IPv4 host bits to the network address', () => {
    expect(
      normaliseIdentifiers('network_range', one('cidr', '10.1.2.77/24')).identifiers[0]?.value,
    ).toBe('10.1.2.0/24');
    expect(
      normaliseIdentifiers('network_range', one('cidr', '192.168.9.9/0')).identifiers[0]?.value,
    ).toBe('0.0.0.0/0');
  });

  it('refuses a bad address, a missing or out-of-range prefix', () => {
    for (const bad of [
      '10.0.0.0',
      '10.0.0.0/33',
      '999.1.1.1/24',
      'example.com/24',
      '10.0.0.0/-1',
    ]) {
      expect(codeOf(() => normaliseIdentifiers('network_range', one('cidr', bad)))).toBe(
        'ASSET_INVALID_IDENTIFIER',
      );
    }
  });

  it('lowercases an IPv6 prefix and keeps its prefix length', () => {
    expect(
      normaliseIdentifiers('network_range', one('cidr', '2001:DB8::/32')).identifiers[0]?.value,
    ).toBe('2001:db8::/32');
  });
});

describe('normaliseIdentifiers: repository assets', () => {
  it('requires https, drops a trailing slash and a .git suffix', () => {
    expect(
      normaliseIdentifiers('source_repo', one('repo', 'https://git.example.com/acme/widgets.git/'))
        .identifiers[0]?.value,
    ).toBe('https://git.example.com/acme/widgets');
  });

  it('refuses plain http and a repository URL without a path', () => {
    expect(
      codeOf(() => normaliseIdentifiers('source_repo', one('repo', 'http://git.example.com/a/b'))),
    ).toBe('ASSET_INVALID_IDENTIFIER');
    expect(
      codeOf(() => normaliseIdentifiers('source_repo', one('repo', 'https://git.example.com/'))),
    ).toBe('ASSET_INVALID_IDENTIFIER');
  });
});

describe('normaliseIdentifiers: kind and duplicates', () => {
  it('refuses an identifier whose kind does not match the asset type', () => {
    expect(codeOf(() => normaliseIdentifiers('host', one('url', 'https://a.example.com')))).toBe(
      'ASSET_INVALID_IDENTIFIER',
    );
    expect(codeOf(() => normaliseIdentifiers('web_app', one('host', 'a.example.com')))).toBe(
      'ASSET_INVALID_IDENTIFIER',
    );
  });

  it('drops duplicates after normalisation, keeps the first, and warns', () => {
    const result = normaliseIdentifiers('host', [
      { kind: 'host', value: 'A.example.com' },
      { kind: 'host', value: 'b.example.com' },
      { kind: 'host', value: 'a.example.com.' },
    ]);
    expect(result.identifiers.map((i) => i.value)).toEqual(['a.example.com', 'b.example.com']);
    expect(result.warnings).toEqual(['1 duplicate identifier(s) removed after normalisation']);
  });
});
