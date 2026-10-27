'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { Badge } from '@blackwing/ui';

import {
  PAUSE_REASON_LABELS,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  isTerminalState,
} from '../../../../../lib/run-states';

import type { RunDetail } from '../../../../../lib/run-detail';

/** Assets listed before the rest collapse into "+N more". */
const MAX_VISIBLE_ASSETS = 3;
const TICK_MS = 5000;
const MS_PER_SECOND = 1000;
const JUST_NOW_SECONDS = 10;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** "just now", "5 minutes ago" … for the "last updated" label. */
export function formatRelative(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / MS_PER_SECOND));
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (seconds < SECONDS_PER_MINUTE)
    return seconds < JUST_NOW_SECONDS ? 'just now' : rtf.format(-seconds, 'second');
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.floor(hours / HOURS_PER_DAY), 'day');
}

export interface RunDetailHeaderProps {
  readonly run: RunDetail;
  /** When the data was last fetched (ms since epoch). */
  readonly updatedAt: number;
  /** Kill button slot (LIVERUN-008); told when the run is terminal so it can disable itself. */
  readonly killSlot?: (context: { readonly terminal: boolean }) => ReactNode;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function RunDetailHeader({ run, updatedAt, killSlot }: RunDetailHeaderProps): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  const terminal = isTerminalState(run.state);
  const visible = run.assets.slice(0, MAX_VISIBLE_ASSETS);
  const hidden = run.assets.length - visible.length;
  return (
    <header className="space-y-4" data-testid="run-detail-header" data-terminal={terminal}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{run.publicId}</h1>
          <Badge variant={RUN_STATE_TONES[run.state]} data-testid="run-state-badge">
            {RUN_STATE_LABELS[run.state]}
            {run.pauseReason !== null && ` · ${PAUSE_REASON_LABELS[run.pauseReason]}`}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" data-testid="run-last-updated">
            Updated {formatRelative(updatedAt, now)}
          </span>
          {killSlot?.({ terminal })}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Field label="Assets">
          <span data-testid="run-assets">
            {visible.map((a) => a.name).join(', ')}
            {hidden > 0 && ` +${String(hidden)} more`}
          </span>
        </Field>
        <Field label="Mode">{run.mode}</Field>
        <Field label="Trigger">{run.trigger}</Field>
        <Field label="Requested by">{run.requestedBy}</Field>
        <Field label="Started">{run.startedAt ?? '—'}</Field>
        <Field label="Ended">{run.endedAt ?? '—'}</Field>
      </dl>
    </header>
  );
}
