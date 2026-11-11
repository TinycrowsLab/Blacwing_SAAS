'use client';

// "Proof screenshot: probe / control" of a proven finding: what a browser showed for the probe and for its negative
// control, side by side; click one to enlarge it. When none was taken the capture's own note says why. The PNGs come
// from /api/findings/:id/screenshots/:kind (signed-in users of the tenant only).
import { useState } from 'react';

import type { FindingDetail } from './model';

type Shots = NonNullable<FindingDetail['evidence']['screenshots']>;
const KINDS = ['probe', 'control'] as const;
const LABEL = { probe: 'Probe', control: 'Control' } as const;
const srcOf = (id: string, kind: (typeof KINDS)[number]): string => `/api/findings/${id}/screenshots/${kind}`;

export function ProofShots({ id, shots }: { readonly id: string; readonly shots: Shots | undefined }) {
  const [open, setOpen] = useState<(typeof KINDS)[number] | null>(null);
  if (shots === undefined) return null;
  const have = KINDS.filter((k) => shots[k] !== undefined);
  if (have.length === 0)
    return shots.note === undefined ? null : (
      <p className="m-0 text-[12.5px] text-muted-foreground">Proof screenshot: {shots.note}</p>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="proof-shots">
      <div className="text-[12.5px] font-medium text-muted-foreground">
        Proof screenshot: {have.map((k) => LABEL[k].toLowerCase()).join(' / ')} · click to enlarge
      </div>
      <div className="grid gap-2.5 md:grid-cols-2">
        {have.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setOpen(kind);
            }}
            className="flex min-w-0 cursor-zoom-in flex-col gap-1 overflow-hidden rounded-xl border border-border bg-code p-0 text-left"
            aria-label={`Enlarge the ${LABEL[kind].toLowerCase()} screenshot`}
          >
            <span className="px-3.5 pt-2 text-[12px] font-semibold text-foreground">
              {LABEL[kind]}
              {shots[kind]?.mode === 'rendered' ? ' (drawn from the recorded response)' : ''}
            </span>
            <img
              src={srcOf(id, kind)}
              alt={`Proof screenshot: ${kind}`}
              loading="lazy"
              className="block h-auto w-full border-t border-border"
              width={shots[kind]?.width}
              height={shots[kind]?.height}
            />
          </button>
        ))}
      </div>
      {open === null ? null : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${LABEL[open]} screenshot`}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center overflow-auto bg-black/70 p-4"
          onClick={() => {
            setOpen(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(null);
          }}
          tabIndex={-1}
        >
          <img src={srcOf(id, open)} alt={`Proof screenshot: ${open}, enlarged`} className="max-h-full max-w-full rounded-lg bg-white" />
        </div>
      )}
    </div>
  );
}
