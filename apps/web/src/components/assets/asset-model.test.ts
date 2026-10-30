import { describe, expect, it } from 'vitest';

import { ASSET_IDENTIFIER_LIMIT } from '@blackwing/contracts';

import {
  canReadAssets,
  canWriteAssets,
  createAssetFormSchema,
  identifierLines,
  identifierProblem,
  toCreateAssetBody,
  verificationHint,
} from './asset-model';

const OWNER = '018f2a6e-1c00-7000-8000-000000000001';

describe('asset permission gates (cosmetic; the server enforces)', () => {
  it('lets asset_owner write, and read-only roles only read', () => {
    expect(canWriteAssets(['asset_owner'])).toBe(true);
    expect(canWriteAssets(['developer'])).toBe(false);
    expect(canWriteAssets(['auditor'])).toBe(false);
    expect(canReadAssets(['auditor'])).toBe(true);
  });

  it('ignores roles it does not know and grants nothing for an empty role list', () => {
    expect(canReadAssets([])).toBe(false);
    expect(canWriteAssets(['made_up_role'])).toBe(false);
    expect(canReadAssets(['made_up_role', 'developer'])).toBe(true);
  });
});

describe('identifierProblem', () => {
  it.each([
    ['host', 'app.example.test', null],
    ['host', 'APP.example.test.', null],
    ['host', '192.0.2.10', null],
    ['host', '2001:db8::1', null],
    ['host', 'bad_label.example.test', 'Expected a DNS hostname or an IP address'],
    ['host', 'a..b', 'Expected a DNS hostname or an IP address'],
    ['web_app', 'https://app.example.test/login', null],
    ['web_app', 'app.example.test', 'Expected an absolute URL'],
    ['web_app', 'ftp://app.example.test', 'Scheme must be http: or https:'],
    ['web_app', 'https://user:secret@app.example.test', 'A URL must not embed credentials'],
    ['api', 'https://', 'Expected an absolute URL'],
    ['source_repo', 'https://git.example.test/acme/api.git', null],
    ['source_repo', 'http://git.example.test/acme/api', 'Scheme must be https:'],
    ['source_repo', 'https://git.example.test/', 'Repository URL must name a path'],
    ['network_range', '10.0.0.0/24', null],
    ['network_range', '10.0.0.0', 'Expected CIDR notation, for example 10.0.0.0/24'],
    ['network_range', '10.0.0.0/33', 'The prefix must be between 0 and 32'],
    ['network_range', '300.0.0.0/8', 'The address is not an IP address'],
    ['network_range', '2001:db8::/32', null],
  ] as const)('%s %s', (type, value, expected) => {
    expect(identifierProblem(type, value)).toBe(expected);
  });

  it('refuses an empty line and one over the URL length limit', () => {
    expect(identifierProblem('host', '   ')).toBe('Enter an identifier');
    expect(identifierProblem('web_app', `https://a.test/${'x'.repeat(2100)}`)).toBe(
      'Keep it under 2048 characters',
    );
  });
});

describe('createAssetFormSchema', () => {
  const base = { name: 'Checkout', type: 'web_app', environment: 'dev' } as const;

  it('accepts valid values and names the line that is wrong', () => {
    expect(
      createAssetFormSchema.safeParse({ ...base, identifiers: 'https://a.test\n\nhttps://b.test' })
        .success,
    ).toBe(true);
    const bad = createAssetFormSchema.safeParse({
      ...base,
      identifiers: 'https://a.test\nnot a url',
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.message)).toEqual([
      'Line 2: Expected an absolute URL',
    ]);
  });

  it('requires a name, at least one identifier, and at most the identifier limit', () => {
    expect(
      createAssetFormSchema.safeParse({ ...base, name: '  ', identifiers: 'https://a.test' })
        .success,
    ).toBe(false);
    expect(createAssetFormSchema.safeParse({ ...base, identifiers: ' \n ' }).success).toBe(false);
    const many = Array.from(
      { length: ASSET_IDENTIFIER_LIMIT + 1 },
      (_, i) => `https://h${String(i)}.test`,
    ).join('\n');
    expect(
      createAssetFormSchema.safeParse({ ...base, identifiers: many }).error?.issues[0]?.message,
    ).toMatch(/at most 50 identifiers/);
  });
});

describe('toCreateAssetBody', () => {
  it('derives the identifier kind from the type, trims lines and sets the owner', () => {
    expect(
      toCreateAssetBody(
        {
          name: ' Checkout ',
          type: 'network_range',
          environment: 'test',
          identifiers: ' 10.0.0.0/24 \n\n10.0.1.0/24',
        },
        OWNER,
      ),
    ).toEqual({
      type: 'network_range',
      name: 'Checkout',
      environment: 'test',
      ownerUserId: OWNER,
      identifiers: [
        { kind: 'cidr', value: '10.0.0.0/24' },
        { kind: 'cidr', value: '10.0.1.0/24' },
      ],
    });
  });

  it('is the one place a body is built: a non-uuid owner is refused by the shared contract', () => {
    expect(() =>
      toCreateAssetBody(
        { name: 'x', type: 'host', environment: 'dev', identifiers: 'h.test' },
        'not-a-uuid',
      ),
    ).toThrow();
  });
});

describe('identifierLines and verificationHint', () => {
  it('keeps the non-empty trimmed lines, whatever the line ending', () => {
    expect(identifierLines(' a \r\n\r\n b\n')).toEqual(['a', 'b']);
  });

  it('explains every non-verified state and confirms the verified one', () => {
    expect(verificationHint('verified')).toMatch(/can be assessed/);
    expect(verificationHint('pending')).toMatch(/cannot be assessed yet/);
    expect(verificationHint('rejected')).toMatch(/again/);
    expect(verificationHint('unverified')).toMatch(/Verify the asset/);
  });
});
