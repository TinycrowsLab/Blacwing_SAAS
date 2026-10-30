'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useMemo } from 'react';

import { type OrgProfile, type OrgSettings, orgSettingsSchema } from '@blackwing/contracts';
import { Button, Input, Label, QueryState, toast } from '@blackwing/ui';

import { isApiError } from '../../lib/api-error';
import { toastApiError } from '../../lib/api-error-toast';
import {
  createOrgSettingsApi,
  type OrgSettingsApi,
  orgProfileKey,
} from '../../lib/org-settings-api';
import { useZodForm } from '../form/use-zod-form';

/** The wire code of a stale `If-Match` (the registry's `ETAG_MISMATCH`, lower-cased on the wire). */
const ETAG_MISMATCH = 'etag_mismatch';

/** IANA zone names offered as suggestions; the server and the schema are the authority on what is accepted. */
const TIME_ZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone');

const FIELD_CLASS = 'grid gap-1.5';
const ERROR_CLASS = 'text-sm text-destructive';

type FormValues = OrgSettings;

function valuesOf(profile: OrgProfile): FormValues {
  return {
    name: profile.name,
    defaultTimezone: profile.defaultTimezone,
    supportContactEmail: profile.supportContactEmail,
  };
}

/** Only the fields the user changed are sent, so a stale view never rewrites a field it did not touch. */
function changedFieldsOf(
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, boolean | undefined>>,
): Partial<FormValues> {
  const body: Partial<FormValues> = {};
  if (dirty.name === true) body.name = values.name;
  if (dirty.defaultTimezone === true) body.defaultTimezone = values.defaultTimezone;
  if (dirty.supportContactEmail === true) body.supportContactEmail = values.supportContactEmail;
  return body;
}

export interface OrgSettingsFormProps {
  /** Test seam; defaults to the console's organisation API. */
  readonly api?: OrgSettingsApi | undefined;
  /** False for a role that may read the profile but not change it: the fields are shown read-only. */
  readonly canEdit?: boolean | undefined;
}

/**
 * The organisation profile (ADMIN-001): the editable name, display zone and support contact, with the
 * read-only slug, region, plan and status. Validation runs in the browser with the shared schema; the server
 * re-validates every field and enforces the admin role. A save sends `If-Match` from the last read.
 */
export function OrgSettingsForm({ api, canEdit = true }: OrgSettingsFormProps) {
  const orgApi = useMemo(() => api ?? createOrgSettingsApi(), [api]);
  const queryClient = useQueryClient();
  // Not refetched on focus: a background refetch would silently move the ETag under an open edit.
  const profile = useQuery({
    queryKey: orgProfileKey,
    queryFn: ({ signal }) => orgApi.get(signal),
    refetchOnWindowFocus: false,
  });
  const failure = profile.error === null ? null : isApiError(profile.error) ? profile.error : {};
  return (
    <QueryState
      isPending={profile.isPending}
      error={failure}
      isEmpty={false}
      empty={{ title: 'No organisation profile', description: 'The profile could not be found.' }}
      loadingVariant="detail"
      onRetry={() => {
        void profile.refetch();
      }}
      isRetrying={profile.isFetching}
    >
      {profile.data === undefined ? null : (
        <OrgProfileEditor
          profile={profile.data}
          canEdit={canEdit}
          onSaved={async () => {
            await queryClient.invalidateQueries({ queryKey: orgProfileKey });
          }}
          save={(body) => orgApi.update(body)}
          onReload={() => {
            void queryClient.invalidateQueries({ queryKey: orgProfileKey });
          }}
        />
      )}
    </QueryState>
  );
}

interface EditorProps {
  readonly profile: OrgProfile;
  readonly canEdit: boolean;
  readonly save: (body: Partial<FormValues>) => Promise<OrgProfile>;
  readonly onSaved: () => Promise<void>;
  readonly onReload: () => void;
}

function OrgProfileEditor({ profile, canEdit, save, onSaved, onReload }: EditorProps) {
  const form = useZodForm(orgSettingsSchema, { defaultValues: valuesOf(profile) });
  const mutation = useMutation({
    mutationFn: (body: Partial<FormValues>) => save(body),
    onSuccess: async (saved) => {
      form.reset(valuesOf(saved));
      toast.success({ title: 'Organisation profile saved' });
      await onSaved();
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.code === ETAG_MISMATCH) return;
      if (isApiError(error)) toastApiError(error);
      else toast.error({ title: 'Organisation profile not saved', description: 'Try again.' });
    },
  });
  const conflict = isApiError(mutation.error) && mutation.error.code === ETAG_MISMATCH;
  const dirty = form.formState.dirtyFields;
  const errors = form.formState.errors;

  return (
    <form
      noValidate
      aria-label="Organisation profile"
      className="grid gap-5"
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          const body = changedFieldsOf(values, dirty);
          if (Object.keys(body).length === 0) return undefined;
          return mutation.mutateAsync(body).catch(() => undefined);
        })(event);
      }}
    >
      <fieldset disabled={!canEdit || mutation.isPending} className="grid gap-5">
        <div className={FIELD_CLASS}>
          <Label htmlFor="org-name">Organisation name</Label>
          <Input
            id="org-name"
            autoComplete="organization"
            aria-invalid={errors.name !== undefined}
            aria-describedby="org-name-error"
            {...form.register('name')}
          />
          <FieldError id="org-name-error" message={errors.name?.message} />
        </div>

        <div className={FIELD_CLASS}>
          <Label htmlFor="org-timezone">Default time zone</Label>
          <Input
            id="org-timezone"
            list="org-timezone-options"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.defaultTimezone !== undefined}
            aria-describedby="org-timezone-help org-timezone-error"
            {...form.register('defaultTimezone')}
          />
          <datalist id="org-timezone-options">
            {TIME_ZONE_OPTIONS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <p id="org-timezone-help" className="text-xs text-muted-foreground">
            IANA name, such as Europe/Berlin. Times are stored in UTC and shown in this zone.
          </p>
          <FieldError id="org-timezone-error" message={errors.defaultTimezone?.message} />
        </div>

        <div className={FIELD_CLASS}>
          <Label htmlFor="org-support-email">Support contact e-mail</Label>
          <Input
            id="org-support-email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.supportContactEmail !== undefined}
            aria-describedby="org-support-email-error"
            {...form.register('supportContactEmail')}
          />
          <FieldError id="org-support-email-error" message={errors.supportContactEmail?.message} />
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Read-only details</legend>
        <ReadOnlyField id="org-slug" label="Slug" value={profile.slug} />
        <ReadOnlyField id="org-region" label="Data region" value={profile.region} />
        <ReadOnlyField id="org-plan" label="Plan" value={profile.plan} />
        <ReadOnlyField id="org-status" label="Status" value={profile.status} />
      </fieldset>

      {conflict ? (
        <div role="alert" className="grid gap-2 rounded-md border border-border p-3">
          <p className="text-sm text-destructive">
            This profile changed since you opened it. Reload to see the latest version before you
            save again.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={onReload}>
              Reload profile
            </Button>
          </div>
        </div>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!form.formState.isDirty || mutation.isPending}
            onClick={() => {
              form.reset(valuesOf(profile));
            }}
          >
            Discard changes
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only a tenant administrator can change this.
        </p>
      )}
    </form>
  );
}

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return message === undefined ? (
    <span id={id} />
  ) : (
    <p id={id} role="alert" className={ERROR_CLASS}>
      {message}
    </p>
  );
}

function ReadOnlyField({
  id,
  label,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className={FIELD_CLASS}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} readOnly value={value} className="text-muted-foreground" />
    </div>
  );
}
