'use client';

import { Badge } from '@blackwing/ui';

import { confidencePercent, SURFACE_KIND_LABELS } from '../../../../../../lib/surface-view';

import type { SurfaceNodeView } from '@blackwing/contracts';
import type { ReactNode } from 'react';

export interface SurfaceInspectorProps {
  readonly node: SurfaceNodeView | null;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Time({ value }: { readonly value: string }) {
  return <time dateTime={value}>{value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time>;
}

/**
 * The inspector of the selected node: what it is, how sure the platform is, and where it came from. Provenance is a
 * summary (run, tool, first and last seen). Captured values and evidence are never part of the view, so none show here.
 */
export function SurfaceInspector({ node }: SurfaceInspectorProps) {
  return (
    <section
      aria-labelledby="surface-inspector-title"
      tabIndex={0}
      className="grid content-start gap-4 rounded-lg border border-border bg-card p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h2 id="surface-inspector-title" className="text-sm font-semibold">
        Node inspector
      </h2>
      {node === null ? (
        <p className="text-sm text-muted-foreground">
          Select a node to see what it is and where it came from.
        </p>
      ) : (
        <div className="grid gap-4" data-testid="surface-inspector-node">
          <div className="grid gap-2">
            <Badge variant="outline">{SURFACE_KIND_LABELS[node.kind]}</Badge>
            <p className="break-all font-mono text-sm">{node.label}</p>
            <p className="text-xs text-warning">Discovered by the agent. Not verified.</p>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Confidence">{confidencePercent(node.confidence)}%</Field>
            <Field label="Edges in view">{String(node.degree)}</Field>
            {node.inScope !== undefined && (
              <Field label="Scope">{node.inScope ? 'In scope' : 'Out of scope'}</Field>
            )}
          </dl>
          <dl className="grid gap-3 border-t border-border pt-3">
            <Field label="Run">
              <span className="font-mono text-xs">{node.provenance.runId}</span>
            </Field>
            <Field label="Tool">{node.provenance.tool ?? 'Not recorded'}</Field>
            <Field label="First seen">
              <Time value={node.provenance.firstSeenAt} />
            </Field>
            <Field label="Last seen">
              <Time value={node.provenance.lastSeenAt} />
            </Field>
          </dl>
        </div>
      )}
    </section>
  );
}
