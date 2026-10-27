'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type SyntheticEvent, type ReactNode } from 'react';

import {
  isKillOpen,
  killConfirmationPhrase,
  KILL_REASON_MIN,
  matchesKillConfirmation,
  type OperatorKillEventSummary,
  type OperatorKillScope,
  uuidV7Schema,
} from '@blackwing/contracts';
import {
  Badge,
  Button,
  FormField,
  Input,
  LoadingState,
  PermissionDenied,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@blackwing/ui';

import { formatSeconds, KillProgress } from './kill-progress';
import { isApiError } from '../../lib/api-error';
import {
  createOperatorKillApi,
  type OperatorKillApi,
  operatorKillKeys,
} from '../../lib/operator-kill-api';
import { uuidV7 } from '../../lib/uuid7';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const DEFAULT_POLL_MS = 1000;
const META = { suppressGlobalError: true } as const;

export interface GlobalKillPanelProps {
  /** Test seam; defaults to the `/operator/v1` client. */
  readonly api?: OperatorKillApi;
  /** How often an open kill is re-read. */
  readonly pollIntervalMs?: number;
}

function describe(error: unknown): string {
  if (!isApiError(error)) return 'The request could not be completed.';
  return error.detail === undefined ? error.title : `${error.title}: ${error.detail}`;
}

const statusBadge = (status: OperatorKillEventSummary['status']): ReactNode => (
  <Badge variant={status === 'halted' ? 'success' : isKillOpen(status) ? 'warning' : 'danger'}>
    {status.replace('_', ' ')}
  </Badge>
);

/**
 * The platform operator's kill control (F33, §1.2, §8.5). It shows the blast radius before anything can
 * fire, requires a typed phrase and a reason, then renders what the deterministic kill path measures. It
 * never reports a halt the path has not confirmed, and it shows a partial kill as exactly that (§8.11).
 */
export function GlobalKillPanel({
  api: apiOverride,
  pollIntervalMs = DEFAULT_POLL_MS,
}: GlobalKillPanelProps): ReactNode {
  const api = useMemo(() => apiOverride ?? createOperatorKillApi(), [apiOverride]);
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<OperatorKillScope>('global');
  const [tenantId, setTenantId] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [killId, setKillId] = useState<string | null>(null);

  const tenantValid = scope === 'global' || uuidV7Schema.safeParse(tenantId.trim()).success;
  const tenant = scope === 'tenant' ? tenantId.trim() : undefined;

  const history = useQuery({
    queryKey: operatorKillKeys.events,
    queryFn: ({ signal }) => api.events(signal),
    meta: META,
  });

  const preview = useMutation({
    mutationFn: () => api.blastRadius(scope, tenant),
    meta: META,
  });

  // One key per distinct request: a double submit repeats it (one kill), an edit starts a new one.
  const keyRef = useRef<{ signature: string; key: string }>({ signature: '', key: '' });
  const signature = JSON.stringify([scope, tenant, reason.trim()]);
  if (keyRef.current.signature !== signature) keyRef.current = { signature, key: uuidV7() };

  const fire = useMutation({
    mutationFn: () =>
      api.fire(
        { scope, ...(tenant === undefined ? {} : { tenantId: tenant }), reason: reason.trim() },
        keyRef.current.key,
      ),
    meta: META,
    onSuccess: (response) => {
      setKillId(response.killEventId);
      void queryClient.invalidateQueries({ queryKey: operatorKillKeys.events });
    },
    onError: async (error) => {
      // Someone already fired this scope (or this is the same kill again): follow that kill.
      const settled = await history.refetch();
      if (isApiError(error) && error.code === 'KILL_ALREADY_IN_PROGRESS') {
        const open = settled.data?.find(
          (e) =>
            isKillOpen(e.status) &&
            e.scope === scope &&
            (scope === 'global' || e.tenantId === tenant),
        );
        if (open !== undefined) setKillId(open.id);
      }
    },
  });

  const status = useQuery({
    queryKey: operatorKillKeys.event(killId ?? ''),
    queryFn: ({ signal }) => api.event(killId ?? '', signal),
    enabled: killId !== null,
    refetchInterval: (query) =>
      query.state.data !== undefined && !isKillOpen(query.state.data.status)
        ? false
        : pollIntervalMs,
    retry: false,
    meta: META,
  });

  const killOpen = killId !== null && (status.data === undefined || isKillOpen(status.data.status));

  const previewError = preview.isError ? preview.error : null;
  // A refused or invalid preview blocks the kill; an unavailable one must not (safety favours stopping).
  const previewBlocked =
    isApiError(previewError) &&
    [HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE].includes(previewError.status);
  const radiusUnknown = previewError !== null && !previewBlocked;
  const previewed = preview.isSuccess || radiusUnknown;

  const expected = killConfirmationPhrase(scope, preview.data?.tenantSlug ?? tenant ?? '');
  const confirmed = matchesKillConfirmation(typed, expected);
  const reasonOk = reason.trim().length >= KILL_REASON_MIN;
  const canFire = previewed && confirmed && reasonOk && !fire.isPending && !killOpen;

  const changeScope = (next: OperatorKillScope): void => {
    setScope(next);
    setTyped('');
    preview.reset();
    fire.reset();
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (canFire) fire.mutate();
  };

  const startOver = (): void => {
    setKillId(null);
    setReason('');
    setTyped('');
    preview.reset();
    fire.reset();
  };

  if (isApiError(history.error) && history.error.status === HTTP_FORBIDDEN) {
    return (
      <PermissionDenied
        permission="platform:global_kill"
        contact="a Blackwing platform administrator"
      />
    );
  }

  const fireError = fire.isError ? fire.error : null;
  const tenantError =
    tenantId !== '' && !tenantValid
      ? 'Enter a valid tenant id.'
      : previewBlocked
        ? describe(previewError)
        : undefined;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header>
        <h1 className="text-xl font-semibold">Global kill</h1>
        <p className="text-sm text-muted-foreground">
          Stops every agent in scope at once: the egress gateway blocks first, then sandboxes are
          terminated, model keys revoked and workflows cancelled.
        </p>
      </header>

      <form onSubmit={submit} className="grid gap-5" aria-label="Fire a kill">
        <fieldset className="grid gap-2" disabled={killOpen}>
          <legend className="text-sm font-medium">Scope</legend>
          {(
            [
              ['global', 'Entire platform', 'Every run of every tenant'],
              ['tenant', 'One tenant', 'Every run of the tenant you name'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="kill-scope"
                value={value}
                checked={scope === value}
                onChange={() => {
                  changeScope(value);
                }}
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          {scope === 'tenant' && (
            <FormField
              label="Tenant id"
              description="The tenant's UUID. Its name is shown once you preview."
              {...(tenantError === undefined ? {} : { error: tenantError })}
            >
              {(control) => (
                <Input
                  {...control}
                  value={tenantId}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setTenantId(e.target.value);
                    setTyped('');
                    preview.reset();
                  }}
                />
              )}
            </FormField>
          )}
        </fieldset>

        <div className="grid gap-2">
          <div>
            <Button
              variant="outline"
              disabled={!tenantValid || preview.isPending || killOpen}
              onClick={() => {
                preview.mutate();
              }}
            >
              {preview.isPending ? 'Checking blast radius' : 'Preview blast radius'}
            </Button>
          </div>
          {preview.isSuccess && (
            <dl
              aria-label="Blast radius"
              className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-4"
            >
              {(
                [
                  ['Runs', preview.data.runsAffected],
                  ['Sandboxes', preview.data.sandboxesAffected],
                  ['Sessions', preview.data.sessionsAffected],
                  ['Tenants', preview.data.tenantsAffected],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {radiusUnknown && (
            <p role="alert" className="text-sm font-medium text-warning">
              Blast radius unavailable ({describe(previewError)}). The radius is unknown, but you
              can still fire the kill.
            </p>
          )}
          {!previewed && !previewBlocked && (
            <p className="text-sm text-muted-foreground">
              Preview the blast radius before you can fire.
            </p>
          )}
        </div>

        <FormField
          label="Reason"
          description="Recorded in the audit ledger, visible to the affected tenants."
        >
          {(control) => (
            <textarea
              {...control}
              rows={3}
              maxLength={2000}
              value={reason}
              disabled={killOpen}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          )}
        </FormField>

        <FormField
          label={`Type ${expected} to confirm`}
          description="Exactly as shown. This cannot be undone."
        >
          {(control) => (
            <Input
              {...control}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={killOpen}
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
          )}
        </FormField>

        <div>
          <Button type="submit" variant="kill" size="lg" disabled={!canFire}>
            {fire.isPending ? 'Firing' : 'Fire kill'}
          </Button>
        </div>

        {fireError !== null && (
          <p role="alert" className="text-sm font-medium text-danger">
            {isApiError(fireError) && fireError.code === 'KILL_ALREADY_IN_PROGRESS'
              ? `A kill is already in progress for this scope. ${describe(fireError)}`
              : isApiError(fireError) && fireError.code === 'KILL_PARTIAL'
                ? `The kill only partly completed. ${describe(fireError)}`
                : `The kill was not confirmed. ${describe(fireError)}`}
          </p>
        )}
      </form>

      <div aria-live="polite">
        {killId !== null && status.data === undefined && !status.isError && (
          <LoadingState label="Waiting for the kill path" />
        )}
        {status.isError && (
          <p role="alert" className="text-sm font-medium text-danger">
            Kill status is unavailable ({describe(status.error)}). It has not been confirmed. Check
            the history below.
          </p>
        )}
        {status.data !== undefined && <KillProgress event={status.data} />}
        {status.data !== undefined && !isKillOpen(status.data.status) && (
          <Button variant="outline" className="mt-3" onClick={startOver}>
            Start another kill
          </Button>
        )}
      </div>

      <section aria-labelledby="kill-history-title" className="grid gap-2">
        <h2 id="kill-history-title" className="text-base font-semibold">
          Kill history
        </h2>
        {history.isPending && <LoadingState variant="table" label="Loading kill history" />}
        {history.isError && (
          <p role="alert" className="text-sm text-danger">
            Kill history is unavailable ({describe(history.error)}).
          </p>
        )}
        {history.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No operator kill has been fired.</p>
        )}
        {history.data !== undefined && history.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fired</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Operator</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Halt time</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.firedAt}</TableCell>
                  <TableCell>
                    {e.scope === 'global' ? 'Global' : `Tenant ${e.tenantId ?? ''}`}
                  </TableCell>
                  <TableCell>{e.actor}</TableCell>
                  <TableCell>{e.reason}</TableCell>
                  <TableCell className="tabular-nums">
                    {e.haltMs === null ? 'Not measured' : formatSeconds(e.haltMs)}
                  </TableCell>
                  <TableCell>{statusBadge(e.status)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
