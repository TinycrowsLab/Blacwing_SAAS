'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ASSET_TYPES, ASSET_ENVIRONMENTS, VERIFICATION_STATUSES } from '@blackwing/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  PermissionDenied,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@blackwing/ui';

import { canWriteAssets } from '../../../../components/assets/asset-model';
import { CreateAssetDialog } from '../../../../components/assets/create-asset-dialog';
import { VerificationStatusBadge } from '../../../../components/assets/verification-status-badge';
import { ApiError, CLIENT_ERROR_CODES } from '../../../../lib/api-error';
import { toastApiError } from '../../../../lib/api-error-toast';
import {
  ASSET_ENVIRONMENT_LABELS,
  ASSET_TYPE_LABELS,
  assetFiltersToSearch,
  hasAssetFilters,
  readAssetFilters,
  type AssetListFilters,
} from '../../../../lib/asset-filters';
import { type AssetRowData, useAssetPages } from '../../../../lib/asset-queries';
import { emitClientEvent } from '../../../../lib/client-events';

import type { AssetApi } from '../../../../lib/asset-api';
import type { GraphQLClient } from '../../../../lib/graphql-client';

const ROUTE = '/assets';
const HTTP_FORBIDDEN = 403;
const TAGS_SHOWN = 3;
const TRUNCATE_AT = 40;
const SKELETON_ROWS = 5;
const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface AssetsViewProps {
  /** Roles of the signed-in user. The gates are cosmetic: the server enforces `asset:read` and `asset:write` (§8.11). */
  readonly roles: readonly string[];
  /** The signed-in user's id: the owner of an asset they register. */
  readonly ownerUserId: string;
  /** Test seams; the console's GraphQL and REST clients by default. */
  readonly graphql?: GraphQLClient;
  readonly api?: AssetApi;
}

/**
 * The asset inventory (`/assets`): a filterable, paginated table of the tenant's assets. Filters live in the URL, so a
 * filtered view can be linked and survives a reload. Rows come from the GraphQL `assets` read; a failed read shows a
 * toast and the retry state, and a forbidden one the permission-denied state.
 */
export function AssetsView({ roles, ownerUserId, graphql, api }: AssetsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = useMemo(() => readAssetFilters(searchParams), [searchParams]);
  const [creating, setCreating] = useState(false);
  const canWrite = canWriteAssets(roles);

  const pages = useAssetPages(filters, graphql);
  const rows: readonly AssetRowData[] = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const failure = pages.error instanceof ApiError ? pages.error : null;

  useEffect(() => {
    if (pages.isSuccess)
      emitClientEvent('asset_list_rendered', ROUTE, {
        topic: hasAssetFilters(filters) ? 'filtered' : 'all',
      });
  }, [pages.isSuccess, filters]);

  useEffect(() => {
    if (failure !== null && failure.status !== HTTP_FORBIDDEN) toastApiError(failure);
  }, [failure]);

  const setFilters = (next: AssetListFilters) => {
    const search = assetFiltersToSearch(next);
    router.replace(search === '' ? ROUTE : `${ROUTE}?${search}`, { scroll: false });
  };

  if (failure?.status === HTTP_FORBIDDEN) {
    return <PermissionDenied permission="asset:read" />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="mx-auto grid max-w-7xl gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold">Assets</h1>
            <p className="text-sm text-muted-foreground">
              Systems you can assess. Only a verified asset can be targeted.
            </p>
          </div>
          {canWrite ? (
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              Register asset
            </Button>
          ) : null}
        </header>

        <FilterBar filters={filters} onChange={setFilters} />

        {pages.isPending ? (
          <SkeletonRows />
        ) : pages.isError && rows.length === 0 ? (
          <ErrorState
            error={toErrorLike(pages.error)}
            onRetry={() => {
              void pages.refetch();
            }}
            isRetrying={pages.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyList
            filtered={hasAssetFilters(filters)}
            canWrite={canWrite}
            onCreate={() => {
              setCreating(true);
            }}
            onClear={() => {
              setFilters({});
            }}
          />
        ) : (
          <div className="grid gap-4">
            <div className="overflow-x-auto rounded-md border border-border">
              <Table aria-label="Assets">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Verification</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Groups</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/assets/${asset.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {asset.name}
                        </Link>
                      </TableCell>
                      <TableCell>{ASSET_TYPE_LABELS[asset.type]}</TableCell>
                      <TableCell>{ASSET_ENVIRONMENT_LABELS[asset.environment]}</TableCell>
                      <TableCell>
                        <VerificationStatusBadge status={asset.verification.status} />
                      </TableCell>
                      <TableCell>
                        {asset.owner?.name ?? (
                          <span className="text-muted-foreground">No owner</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Clipped items={asset.tags.map((tag) => `${tag.key}: ${tag.value}`)} />
                      </TableCell>
                      <TableCell>
                        <Clipped items={asset.groups.map((group) => group.name)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {pages.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => {
                    void pages.fetchNextPage();
                  }}
                >
                  {pages.isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {pages.isError && rows.length > 0 ? (
          <div
            role="status"
            className="flex items-center justify-between gap-2 text-sm text-muted-foreground"
          >
            The next page did not load.
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void pages.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {canWrite ? (
          <CreateAssetDialog
            open={creating}
            onOpenChange={setCreating}
            ownerUserId={ownerUserId}
            api={api}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/** The error the list shows: an ApiError as is; anything else (a parse failure) as a generic one, never its message. */
function toErrorLike(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError({
    status: 0,
    code: CLIENT_ERROR_CODES.contractMismatch,
    title: 'Unexpected response',
  });
}

function FilterBar({
  filters,
  onChange,
}: {
  readonly filters: AssetListFilters;
  readonly onChange: (next: AssetListFilters) => void;
}) {
  const patch = (change: Partial<AssetListFilters>) => {
    onChange({ ...filters, ...change });
  };
  return (
    <form
      role="search"
      aria-label="Filter assets"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="asset-filter-type">Type</Label>
        <select
          id="asset-filter-type"
          className={SELECT_CLASS}
          value={filters.type ?? ''}
          onChange={(event) => {
            const value = ASSET_TYPES.find((type) => type === event.target.value);
            patch({ type: value });
          }}
        >
          <option value="">Any type</option>
          {ASSET_TYPES.map((type) => (
            <option key={type} value={type}>
              {ASSET_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="asset-filter-environment">Environment</Label>
        <select
          id="asset-filter-environment"
          className={SELECT_CLASS}
          value={filters.environment ?? ''}
          onChange={(event) => {
            const value = ASSET_ENVIRONMENTS.find(
              (environment) => environment === event.target.value,
            );
            patch({ environment: value });
          }}
        >
          <option value="">Any environment</option>
          {ASSET_ENVIRONMENTS.map((environment) => (
            <option key={environment} value={environment}>
              {ASSET_ENVIRONMENT_LABELS[environment]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="asset-filter-verification">Verification</Label>
        <select
          id="asset-filter-verification"
          className={SELECT_CLASS}
          value={filters.verificationStatus ?? ''}
          onChange={(event) => {
            const value = VERIFICATION_STATUSES.find((status) => status === event.target.value);
            patch({ verificationStatus: value });
          }}
        >
          <option value="">Any state</option>
          {VERIFICATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      <TextFilter
        id="asset-filter-tag-key"
        label="Tag key"
        value={filters.tagKey}
        max={64}
        onCommit={(value) => {
          patch({ tagKey: value, tagValue: value === undefined ? undefined : filters.tagValue });
        }}
      />
      <TextFilter
        id="asset-filter-tag-value"
        label="Tag value"
        value={filters.tagValue}
        disabled={filters.tagKey === undefined}
        max={200}
        onCommit={(value) => {
          patch({ tagValue: value });
        }}
      />
      <TextFilter
        id="asset-filter-group"
        label="Group"
        value={filters.group}
        max={200}
        onCommit={(value) => {
          patch({ group: value });
        }}
      />
      {hasAssetFilters(filters) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange({});
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </form>
  );
}

/** A text filter that applies on blur or Enter, so the URL and the query change once per edit, not per keystroke. */
function TextFilter({
  id,
  label,
  value,
  disabled = false,
  max,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly disabled?: boolean;
  readonly max: number;
  readonly onCommit: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    onCommit(trimmed === '' || trimmed.length > max ? undefined : trimmed);
  };
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="search"
        className="h-9 w-40"
        value={draft}
        disabled={disabled}
        maxLength={max}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/** Up to a few labels; the rest, and any label too long for the cell, sit behind a tooltip (no unbounded cells). */
function Clipped({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) return <span className="text-muted-foreground">None</span>;
  const shown = items.slice(0, TAGS_SHOWN);
  const all = items.join(', ');
  const hidden = items.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-xs truncate text-sm">
          {shown.map((item) => item.slice(0, TRUNCATE_AT)).join(', ')}
          {hidden > 0 ? ` +${String(hidden)} more` : ''}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">{all}</TooltipContent>
    </Tooltip>
  );
}

function SkeletonRows() {
  return (
    <div aria-busy="true" aria-label="Loading assets" className="grid gap-2">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

function EmptyList({
  filtered,
  canWrite,
  onCreate,
  onClear,
}: {
  readonly filtered: boolean;
  readonly canWrite: boolean;
  readonly onCreate: () => void;
  readonly onClear: () => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        title="No asset matches these filters"
        description="Clear a filter to see more assets."
        action={
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      title="No assets yet"
      description={
        canWrite
          ? 'Register the first system you want to assess.'
          : 'Your organisation has not registered assets yet.'
      }
      action={canWrite ? <Button onClick={onCreate}>Register asset</Button> : undefined}
    />
  );
}
