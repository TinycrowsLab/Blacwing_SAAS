import { describe, expect, it } from 'vitest';

import {
  assetFilterInput,
  assetFiltersToSearch,
  hasAssetFilters,
  readAssetFilters,
} from './asset-filters.js';

describe('readAssetFilters', () => {
  it('reads each filter from the URL and trims the free text', () => {
    expect(
      readAssetFilters(
        new URLSearchParams(
          'type=web_app&environment=prod&verificationStatus=verified&tagKey=%20owner%20&tagValue=blue&group=Public%20web',
        ),
      ),
    ).toEqual({
      type: 'web_app',
      environment: 'prod',
      verificationStatus: 'verified',
      tagKey: 'owner',
      tagValue: 'blue',
      group: 'Public web',
    });
  });

  it('drops an unknown enum value so it never reaches a request (the list then shows "any")', () => {
    expect(
      readAssetFilters({ type: 'mainframe', environment: 'moon', verificationStatus: 'x' }),
    ).toEqual({});
  });

  it('ignores a tag value without a tag key, and blank or over-long text', () => {
    expect(readAssetFilters({ tagValue: 'blue' })).toEqual({});
    expect(readAssetFilters({ tagKey: '   ' })).toEqual({});
    expect(readAssetFilters({ tagKey: 'k'.repeat(65) })).toEqual({});
    expect(readAssetFilters({ tagKey: 'k', tagValue: 'v'.repeat(201) })).toEqual({ tagKey: 'k' });
    expect(readAssetFilters({ group: 'g'.repeat(201) })).toEqual({});
  });

  it('takes the first value of a repeated parameter', () => {
    expect(readAssetFilters({ environment: ['dev', 'prod'] })).toEqual({ environment: 'dev' });
  });
});

describe('assetFiltersToSearch', () => {
  it('writes only the chosen filters and reads back to the same state', () => {
    const filters = { environment: 'test' as const, tagKey: 'owner', tagValue: undefined };
    const search = assetFiltersToSearch(filters);
    expect(search).toBe('environment=test&tagKey=owner');
    expect(readAssetFilters(new URLSearchParams(search))).toEqual({
      environment: 'test',
      tagKey: 'owner',
    });
  });

  it('is empty for no filters, and hasAssetFilters tells the two apart', () => {
    expect(assetFiltersToSearch({})).toBe('');
    expect(hasAssetFilters({})).toBe(false);
    expect(hasAssetFilters({ group: 'g' })).toBe(true);
  });
});

describe('assetFilterInput', () => {
  it('sends only the filters that are set, so the server sees exactly the user choice', () => {
    expect(assetFilterInput({ type: 'api', verificationStatus: undefined, group: 'Edge' })).toEqual(
      {
        type: 'api',
        group: 'Edge',
      },
    );
    expect(assetFilterInput({})).toEqual({});
  });
});
