'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import {
  ASSET_ENVIRONMENTS,
  ASSET_TYPES,
  type CreateAssetBody,
  type AssetType,
} from '@blackwing/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  classifyApiError,
  errorCopy,
  toast,
} from '@blackwing/ui';

import {
  createAssetFormSchema,
  type CreateAssetFormValues,
  identifierLines,
  toCreateAssetBody,
} from './asset-model';
import { ApiError } from '../../lib/api-error';
import { toastApiError } from '../../lib/api-error-toast';
import { type AssetApi, createAssetApi } from '../../lib/asset-api';
import { ASSET_ENVIRONMENT_LABELS, ASSET_TYPE_LABELS } from '../../lib/asset-filters';
import { ASSET_LIST_KEY } from '../../lib/asset-queries';
import { emitClientEvent } from '../../lib/client-events';
import { uuidV7 } from '../../lib/uuid7';
import { useZodForm } from '../form/use-zod-form';

const ROUTE = '/assets';

export interface CreateAssetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The signed-in user, who owns the asset they register. */
  readonly ownerUserId: string;
  /** Test seam; defaults to the console's asset client. */
  readonly api?: AssetApi | undefined;
}

const DEFAULT_VALUES: CreateAssetFormValues = {
  name: '',
  type: 'web_app',
  environment: 'dev',
  identifiers: '',
};

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const TEXTAREA_CLASS =
  'min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Registers an asset (ASSET-002). The identifier box checks each line for the chosen type as the user leaves it, so
 * an invalid value shows its line number before anything is sent. A new asset starts unverified; the server refuses
 * what the console could not check, and that refusal is shown here.
 */
export function CreateAssetDialog({
  open,
  onOpenChange,
  ownerUserId,
  api,
}: CreateAssetDialogProps) {
  const assets = api ?? createAssetApi();
  const queryClient = useQueryClient();
  const form = useZodForm(createAssetFormSchema, { defaultValues: DEFAULT_VALUES });
  const attempt = useRef<{ readonly body: string; readonly key: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (values: CreateAssetFormValues) => {
      const body: CreateAssetBody = toCreateAssetBody(values, ownerUserId);
      const serialised = JSON.stringify(body);
      // One Idempotency-Key per distinct body: a retried submit of the same form reuses it, a changed form gets a new one.
      if (attempt.current?.body !== serialised)
        attempt.current = { body: serialised, key: uuidV7() };
      return assets.create(body);
    },
    onSuccess: async (asset) => {
      attempt.current = null;
      emitClientEvent('asset_created', ROUTE, { topic: asset.verificationStatus });
      toast.success({
        title: 'Asset registered',
        description: `${asset.name} is unverified until its owner is proved.`,
      });
      await queryClient.invalidateQueries({ queryKey: ASSET_LIST_KEY });
      form.reset(DEFAULT_VALUES);
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      emitClientEvent('asset_create_failed', ROUTE, {
        ...(error instanceof ApiError ? { code: error.code, traceId: error.traceId } : {}),
      });
      if (error instanceof ApiError) toastApiError(error);
      else
        toast.error({
          title: 'Asset not registered',
          description: 'Check the values and try again.',
        });
    },
  });

  const submitError = mutation.error === null ? null : failureMessage(mutation.error);
  const identifierCount = identifierLines(form.watch('identifiers')).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register an asset</DialogTitle>
          <DialogDescription>
            A new asset starts unverified. It can be assessed once its owner is proved.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          aria-label="Register an asset"
          className="grid gap-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => mutation.mutateAsync(values).catch(() => undefined))(
              event,
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="asset-name">Name</Label>
            <Input
              id="asset-name"
              autoComplete="off"
              aria-invalid={form.formState.errors.name !== undefined}
              {...form.register('name')}
            />
            <FieldError message={form.formState.errors.name?.message} id="asset-name-error" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="asset-type">Type</Label>
              <select id="asset-type" className={SELECT_CLASS} {...form.register('type')}>
                {ASSET_TYPES.map((type: AssetType) => (
                  <option key={type} value={type}>
                    {ASSET_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="asset-environment">Environment</Label>
              <select
                id="asset-environment"
                className={SELECT_CLASS}
                {...form.register('environment')}
              >
                {ASSET_ENVIRONMENTS.map((environment) => (
                  <option key={environment} value={environment}>
                    {ASSET_ENVIRONMENT_LABELS[environment]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="asset-identifiers">Identifiers, one per line</Label>
            <textarea
              id="asset-identifiers"
              spellCheck={false}
              className={TEXTAREA_CLASS}
              aria-describedby="asset-identifiers-help asset-identifiers-error"
              aria-invalid={form.formState.errors.identifiers !== undefined}
              {...form.register('identifiers')}
            />
            <p id="asset-identifiers-help" className="text-xs text-muted-foreground">
              {identifierCount === 1 ? '1 identifier' : `${String(identifierCount)} identifiers`}.
              Credentials in a URL are refused.
            </p>
            <FieldError
              message={form.formState.errors.identifiers?.message}
              id="asset-identifiers-error"
            />
          </div>
          {submitError === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Registering...' : 'Register asset'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({
  message,
  id,
}: {
  readonly message: string | undefined;
  readonly id: string;
}) {
  if (message === undefined) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** The inline text for a failed create: fixed copy by error kind, never the server's detail (§8.7). */
function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return errorCopy(classifyApiError(error)).description;
  return 'The asset was not registered. Check the values and try again.';
}
