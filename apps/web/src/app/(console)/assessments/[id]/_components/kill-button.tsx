'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

import {
  KILL_REASON_MIN,
  killTriggerResponseSchema,
  type KillTriggerResponse,
} from '@blackwing/contracts';
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

import {
  canKillRun,
  isKillConfirmed,
  isKillInFlight,
  isRunEnded,
  type KillableRun,
} from './kill-model';
import { createApiClient, type ApiClient } from '../../../../../lib/api-client';
import { isApiError } from '../../../../../lib/api-error';
import { emitClientEvent } from '../../../../../lib/client-events';
import { qk } from '../../../../../lib/query-keys';
import { uuidV7 } from '../../../../../lib/uuid7';

const HTTP_FORBIDDEN = 403;
const KILL_ROUTE_NAME = '/assessments/:id';

export interface KillButtonProps {
  readonly run: KillableRun;
  /** Roles of the signed-in user; the gate is cosmetic, the server enforces `kill:trigger` (§8.11). */
  readonly roles: readonly string[];
  /** Whether the user owns the run's assets (needed by the Asset Owner role). */
  readonly ownsAsset?: boolean;
  /** Called with the server's 202 answer. The real outcome still arrives as `kill.*` events. */
  readonly onAccepted?: (response: KillTriggerResponse) => void;
  /** Test seam; defaults to the console's REST client. */
  readonly client?: ApiClient;
}

interface Attempt {
  readonly key: string;
  readonly reason: string;
}

function KillIcon(): ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z M15 9l-6 6 M9 9l6 6" />
    </svg>
  );
}

/**
 * Stops a run and everything in its scope (F33, §8.5). It only requests the kill: the "killing…" state
 * lasts until the server reports a completed `kill_events` record through `run.killEvent`, and no halt
 * time is ever invented here (see `HaltTimeBadge`).
 */
export function KillButton({
  run,
  roles,
  ownsAsset = false,
  onAccepted,
  client,
}: KillButtonProps): ReactNode {
  const [api] = useState(() => client ?? createApiClient());
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [acceptedTriggeredAt, setAcceptedTriggeredAt] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // The key is reused while the same request is retried; an edited reason is a different request.
  const attempt = useRef<Attempt | null>(null);

  const kill = useMutation({
    mutationFn: ({ key, reason: text }: Attempt) =>
      api.post(
        '/kill',
        killTriggerResponseSchema,
        { scope: 'run', scopeRefId: run.id, reason: text },
        { idempotencyKey: key },
      ),
    meta: { invalidates: [qk.runs.detail(run.id)], suppressGlobalError: true },
    onSuccess: (response) => {
      attempt.current = null;
      setAcceptedTriggeredAt(response.triggeredAt);
      setOpen(false);
      onAccepted?.(response);
    },
    onError: (error) => {
      if (isApiError(error) && error.status === HTTP_FORBIDDEN) {
        setForbidden(true);
        setOpen(false);
      }
    },
  });

  if (!canKillRun(roles, ownsAsset)) return null;

  if (forbidden) {
    return (
      <p role="alert" className="text-sm text-danger">
        You no longer have permission to kill this run.
      </p>
    );
  }

  if (isRunEnded(run)) {
    return (
      <Button variant="kill" disabled>
        <KillIcon />
        Run already ended
      </Button>
    );
  }

  if (isKillInFlight(run.killEvent, acceptedTriggeredAt)) {
    return (
      <div role="status">
        <Button variant="kill" disabled aria-busy="true">
          <KillIcon />
          Killing…
        </Button>
      </div>
    );
  }

  const trimmedReason = reason.trim();
  const canSubmit =
    isKillConfirmed(typed, run.publicId) &&
    trimmedReason.length >= KILL_REASON_MIN &&
    !kill.isPending;

  const onOpenChange = (next: boolean): void => {
    if (kill.isPending) return;
    if (next) {
      setTyped('');
      kill.reset();
    }
    setOpen(next);
  };

  const onSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    if (attempt.current?.reason !== trimmedReason) {
      attempt.current = { key: uuidV7(), reason: trimmedReason };
    }
    emitClientEvent('kill_requested', KILL_ROUTE_NAME, {
      runId: run.publicId,
      idempotencyKey: attempt.current.key,
    });
    kill.mutate(attempt.current);
  };

  const failure = kill.error;
  const copy =
    failure === null ? null : errorCopy(classifyApiError(isApiError(failure) ? failure : {}));
  const traceId = isApiError(failure) ? safeTraceId(failure.traceId) : undefined;

  return (
    <>
      <Button
        variant="kill"
        onClick={() => {
          onOpenChange(true);
        }}
      >
        <KillIcon />
        Kill run
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          role="alertdialog"
          className="border-kill"
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
        >
          <form onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="text-kill">Stop this run now?</DialogTitle>
              <DialogDescription>
                This stops all agents in this run. The egress gateway blocks first, then sandboxes
                end, model keys are revoked and workflows are cancelled. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="kill-reason">Reason (kept in the audit log)</Label>
              <Input
                id="kill-reason"
                value={reason}
                maxLength={500}
                autoComplete="off"
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="kill-confirm">
                Type <span className="font-mono">{run.publicId}</span> to confirm
              </Label>
              <Input
                id="kill-confirm"
                className="font-mono"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            </div>
            {copy === null ? null : (
              <div role="alert" className="text-sm text-danger">
                <p className="font-semibold">{copy.title}</p>
                <p>The run is not confirmed stopped. Try again.</p>
                {traceId === undefined ? null : (
                  <p className="font-mono text-xs">Trace ID: {traceId}</p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={kill.isPending}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="kill" disabled={!canSubmit}>
                {kill.isPending ? 'Requesting…' : 'Stop run'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
