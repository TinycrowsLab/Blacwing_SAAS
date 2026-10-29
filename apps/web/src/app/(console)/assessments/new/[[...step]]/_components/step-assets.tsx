'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@blackwing/ui';

import { useZodForm } from '../../../../../../components/form/use-zod-form';
import { assetAnswerSchema, isSelectableAsset } from '../wizard-model';

import type { AssetListItem } from '@blackwing/contracts';

export interface StepAssetsProps {
  readonly assets: readonly AssetListItem[] | undefined;
  readonly loading: boolean;
  readonly defaultAssetIds: readonly string[];
  readonly pending: boolean;
  readonly onSubmit: (assetIds: string[]) => Promise<void>;
}

/**
 * Step 2: the assets to assess. Only verified assets are selectable (§8.10); an unverified one stays visible with
 * the reason. The server enforces the same rule at submit, so this list only reflects it.
 */
export function StepAssets({
  assets,
  loading,
  defaultAssetIds,
  pending,
  onSubmit,
}: StepAssetsProps) {
  const [filter, setFilter] = useState('');
  const form = useZodForm(assetAnswerSchema, { defaultValues: { assetIds: [...defaultAssetIds] } });
  const selected = form.watch('assetIds');
  const error = form.formState.errors.assetIds?.message;

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading your assets...</p>;
  }
  if (assets === undefined) {
    return (
      <p className="text-sm text-muted-foreground">The asset list is not available right now.</p>
    );
  }
  if (assets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No assets in this tenant yet. Register and verify an asset before creating an assessment
        request.
      </p>
    );
  }

  const needle = filter.trim().toLowerCase();
  const rows =
    needle === '' ? assets : assets.filter((asset) => asset.name.toLowerCase().includes(needle));
  const verifiedCount = assets.filter((asset) =>
    isSelectableAsset(asset.verificationStatus),
  ).length;

  return (
    <form
      noValidate
      aria-labelledby="step-assets-title"
      onSubmit={(event) => {
        void form.handleSubmit((values) => onSubmit(values.assetIds))(event);
      }}
      className="grid gap-4"
    >
      <h2 id="step-assets-title" className="text-lg font-semibold">
        Choose the assets
      </h2>
      {verifiedCount === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          None of your assets is verified yet. A verified asset is required before it can be
          assessed.
        </p>
      ) : null}
      <div className="grid max-w-sm gap-1.5">
        <Label htmlFor="asset-filter">Search assets</Label>
        <Input
          id="asset-filter"
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          placeholder="Name"
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <span className="sr-only">Select</span>
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Environment</TableHead>
            <TableHead>Verification</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((asset) => {
            const selectable = isSelectableAsset(asset.verificationStatus);
            return (
              <TableRow key={asset.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    value={asset.id}
                    aria-label={`Select ${asset.name}`}
                    disabled={!selectable || pending}
                    {...form.register('assetIds')}
                  />
                </TableCell>
                <TableCell className="font-medium">{asset.name}</TableCell>
                <TableCell>{asset.type}</TableCell>
                <TableCell>{asset.environment}</TableCell>
                <TableCell>
                  {selectable ? (
                    asset.verificationStatus
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {asset.verificationStatus}: verify this asset before assessing it.{' '}
                      <Link
                        className="text-primary underline-offset-4 hover:underline"
                        href={`/assets/${asset.id}`}
                      >
                        Open asset
                      </Link>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No asset matches this search.</p>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {String(selected.length)} selected
        </span>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Next'}
        </Button>
      </div>
    </form>
  );
}
