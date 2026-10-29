'use client';

import { useMutation } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

import { type KillApiScope, LIMITS, uuidV7Schema } from '@blackwing/contracts';
import {
  Button,
  classifyApiError,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  errorCopy,
  Input,
  Label,
  safeTraceId,
} from '@blackwing/ui';

import { canTriggerKill, isKillReasonValid, KILL_SCOPE_LABELS, scopeNeedsRef } from './kill-model';
import { isApiError } from '../../lib/api-error';
import { emitClientEvent } from '../../lib/client-events';
import { createTenantKillApi, type TenantKillApi } from '../../lib/tenant-kill-api';
import { uuidV7 } from '../../lib/uuid7';

const HTTP_FORBIDDEN = 403;

export interface KillButtonProps {
  readonly scope: KillApiScope;
  /** The run or asset id a run/asset kill names (a UUID). Not used for a tenant kill. */
  readonly scopeRefId?: string | undefined;
  /** Roles of the signed-in user. The gate is cosmetic: the server enforces `kill:trigger` (§8.11). */
  readonly roles: readonly string[];
  /** Whether the user owns the target asset (the Asset Owner role may kill only owned assets). */
  readonly ownsAsset?: boolean;
  /** Test seam; defaults to the console's kill client. */
  readonly api?: TenantKillApi;
  /** Called with the server's `killEventId` once the kill is accepted (202). */
  readonly onAccepted: (killEventId: string) => void;
}

interface Attempt {
  readonly key: string;
  readonly reason: string;
}

/**
 * Stops testing for one scope (F33, §8.5): a button that opens a confirm dialog. The dialog needs a
 * reason (kept in the audit log) and an explicit "Stop testing now". It only requests the kill; the
 * progress arrives from `KillStatusPanel`, which reads the server's measured record.
 */
export function KillButton({
  scope,
  scopeRefId,
  roles,
  ownsAsset = false,
  api,
  onAccepted,
}: KillButtonProps): ReactNode {
  const [client] = useState(() => api ?? createTenantKillApi());
  const ids = useId();
  const reasonId = `${ids}-reason`;
  const hintId = `${ids}-hint`;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [forbidden, setForbidden] = useState(false);
  // The key is reused while the same request is retried; an edited reason is a different request.
  const attempt = useRef<Attempt | null>(null);

  const refOk = scopeNeedsRef(scope)
    ? scopeRefId !== undefined && uuidV7Schema.safeParse(scopeRefId).success
    : scopeRefId === undefined;

  const fire = useMutation({
    mutationFn: (current: Attempt) =>
      client.fire(
        {
          scope,
          ...(scopeRefId === undefined ? {} : { scopeRefId }),
          reason: current.reason,
        },
        current.key,
      ),
    meta: { suppressGlobalError: true },
    onSuccess: (response) => {
      attempt.current = null;
      setReason('');
      setOpen(false);
      onAccepted(response.killEventId);
    },
    onError: (error) => {
      if (isApiError(error) && error.status === HTTP_FORBIDDEN) {
        setForbidden(true);
        setOpen(false);
      }
    },
  });

  if (!refOk || !canTriggerKill(roles, { scope, ownsAsset })) return null;

  if (forbidden) {
    return (
      <p role="alert" className="text-sm text-danger">
        You are not permitted to stop this {KILL_SCOPE_LABELS[scope].toLowerCase()}.
      </p>
    );
  }

  const trimmed = reason.trim();
  const valid = isKillReasonValid(reason);
  const label = KILL_SCOPE_LABELS[scope].toLowerCase();
  const failure = fire.error;
  const copy =
    failure === null ? null : errorCopy(classifyApiError(isApiError(failure) ? failure : {}));
  const traceId = isApiError(failure) ? safeTraceId(failure.traceId) : undefined;

  const onOpenChange = (next: boolean): void => {
    if (fire.isPending) return;
    if (next) {
      setReason('');
      fire.reset();
    }
    setOpen(next);
  };

  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    // A double submit while the first is in flight (or accepted) is ignored: one kill, one key.
    if (!valid || fire.isPending || fire.isSuccess) return;
    if (attempt.current?.reason !== trimmed) attempt.current = { key: uuidV7(), reason: trimmed };
    const current = attempt.current;
    emitClientEvent(
      'kill_triggered_ui',
      typeof window === 'undefined' ? '/' : window.location.pathname,
      { idempotencyKey: current.key },
    );
    fire.mutate(current);
  };

  return (
    <>
      <Button
        variant="kill"
        onClick={() => {
          onOpenChange(true);
        }}
      >
        Stop testing
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          role="alertdialog"
          className="border-kill"
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
        >
          <form
            onSubmit={onSubmit}
            className="grid gap-4"
            aria-label={`Stop testing on this ${label}`}
          >
            <DialogHeader>
              <DialogTitle className="text-kill">Stop testing now?</DialogTitle>
              <DialogDescription>
                This stops every agent in this {label}. The egress gateway blocks first, then
                sandboxes end, model keys are revoked and workflows are cancelled. This cannot be
                undone.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={reasonId}>Reason (required, kept in the audit log)</Label>
              <Input
                id={reasonId}
                value={reason}
                maxLength={LIMITS.reasonMax}
                autoComplete="off"
                aria-describedby={hintId}
                aria-invalid={reason.length > 0 && !valid}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              <p id={hintId} className="text-xs text-muted-foreground">
                Say why you are stopping. At least 3 characters.
              </p>
            </div>
            {copy === null ? null : (
              <div role="alert" className="text-sm text-danger">
                <p className="font-semibold">{copy.title}</p>
                <p>The stop is not confirmed. Try again.</p>
                {traceId === undefined ? null : (
                  <p className="font-mono text-xs">Trace ID: {traceId}</p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={fire.isPending}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="kill" disabled={!valid || fire.isPending}>
                {fire.isPending ? 'Stopping…' : 'Stop testing now'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
