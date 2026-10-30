// The asset inventory list's model (ASSET list page, #368): the filter state that lives in the URL and the
// GraphQL filter it becomes. Pure functions, so the page and its tests share one definition. The server does every
// selection; the client only asks for the filter it shows and presents what comes back.

import {
  ASSET_ENVIRONMENTS,
  ASSET_TYPES,
  LIMITS,
  VERIFICATION_STATUSES,
  type AssetEnvironment,
  type AssetType,
  type VerificationStatus,
} from '@blackwing/contracts';

/** Rows asked for per page. The server caps a page at 200; the list pages with "Load more". */
export const ASSET_PAGE_SIZE = 50;

/**
 * Filter state of the list. An absent field means "any". `tagValue` only means something with a `tagKey`.
 * `group` is the name of a group the asset belongs to.
 */
export interface AssetListFilters {
  readonly type?: AssetType | undefined;
  readonly environment?: AssetEnvironment | undefined;
  readonly verificationStatus?: VerificationStatus | undefined;
  readonly tagKey?: string | undefined;
  readonly tagValue?: string | undefined;
  readonly group?: string | undefined;
}

/** The GraphQL `AssetFilter` input. Absent fields are left out, so the server sees only what the user chose. */
export interface AssetFilterInput {
  readonly type?: string;
  readonly environment?: string;
  readonly verificationStatus?: string;
  readonly tagKey?: string;
  readonly tagValue?: string;
  readonly group?: string;
}

/** The URL search parameters the page reads. Repeated parameters take the first value. */
type SearchParams = Readonly<Record<string, string | string[] | undefined>> | URLSearchParams;

function valueOf(params: SearchParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const raw = params[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

/** Trimmed text within the contract's limit, or undefined. An empty or over-long value is ignored, not sent. */
function text(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' || trimmed.length > max ? undefined : trimmed;
}

/**
 * Reads the filters from the URL. An unknown enum value is dropped (the list then shows "any" for it, which is
 * what the control displays); the server would refuse it, so it never reaches a request.
 */
export function readAssetFilters(params: SearchParams): AssetListFilters {
  const tagKey = text(valueOf(params, 'tagKey'), LIMITS.keyMax);
  const tagValue =
    tagKey === undefined ? undefined : text(valueOf(params, 'tagValue'), LIMITS.labelMax);
  const group = text(valueOf(params, 'group'), LIMITS.labelMax);
  const type = oneOf(valueOf(params, 'type'), ASSET_TYPES);
  const environment = oneOf(valueOf(params, 'environment'), ASSET_ENVIRONMENTS);
  const verificationStatus = oneOf(valueOf(params, 'verificationStatus'), VERIFICATION_STATUSES);
  return {
    ...(type === undefined ? {} : { type }),
    ...(environment === undefined ? {} : { environment }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
    ...(tagKey === undefined ? {} : { tagKey }),
    ...(tagValue === undefined ? {} : { tagValue }),
    ...(group === undefined ? {} : { group }),
  };
}

/** The query string for a filter state (no leading `?`). Empty values are left out, so the URL stays short. */
export function assetFiltersToSearch(filters: AssetListFilters): string {
  const params = new URLSearchParams();
  for (const key of [
    'type',
    'environment',
    'verificationStatus',
    'tagKey',
    'tagValue',
    'group',
  ] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return params.toString();
}

/** True when at least one filter narrows the list. */
export function hasAssetFilters(filters: AssetListFilters): boolean {
  return Object.keys(filters).length > 0;
}

/** The GraphQL `filter` argument for a filter state. */
export function assetFilterInput(filters: AssetListFilters): AssetFilterInput {
  return {
    ...(filters.type === undefined ? {} : { type: filters.type }),
    ...(filters.environment === undefined ? {} : { environment: filters.environment }),
    ...(filters.verificationStatus === undefined
      ? {}
      : { verificationStatus: filters.verificationStatus }),
    ...(filters.tagKey === undefined ? {} : { tagKey: filters.tagKey }),
    ...(filters.tagValue === undefined ? {} : { tagValue: filters.tagValue }),
    ...(filters.group === undefined ? {} : { group: filters.group }),
  };
}

/** Human labels of the enum values, for the filter controls. */
export const ASSET_TYPE_LABELS: Readonly<Record<AssetType, string>> = {
  web_app: 'Web app',
  api: 'API',
  host: 'Host',
  network_range: 'Network range',
  source_repo: 'Source repo',
};

export const ASSET_ENVIRONMENT_LABELS: Readonly<Record<AssetEnvironment, string>> = {
  prod: 'Production',
  staging: 'Staging',
  dev: 'Development',
  test: 'Test',
};
