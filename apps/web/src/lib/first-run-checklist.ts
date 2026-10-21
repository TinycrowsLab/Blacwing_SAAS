import { z } from 'zod';

import type { Permission } from '@blackwing/contracts';
import type { FirstRunStep } from '@blackwing/ui';

/**
 * Tenant facts the checklist is derived from. They come from the tenant's own data on every render, so the
 * checklist reflects completion without any browser storage and cannot go stale across devices.
 */
const firstRunFactsSchema = z.strictObject({
  verifiedAssetCount: z.number().int().nonnegative(),
  activeAuthorisationCount: z.number().int().nonnegative(),
  requestedRunCount: z.number().int().nonnegative(),
});

export interface FirstRunChecklistModel {
  /** False when the tenant already finished the checklist, or the viewer cannot act on any step. */
  readonly visible: boolean;
  readonly complete: boolean;
  readonly steps: readonly FirstRunStep[];
}

/** Permissions that make the checklist useful to a viewer. A viewer with none of them never sees it. */
const ACTIONABLE: readonly Permission[] = ['asset:verify', 'sa:create', 'run:create'];

const CANNOT_ACT = 'Your role cannot do this step. Ask a teammate who can.';

/**
 * The three first-run steps (verify an asset, create a standing authorisation, request an assessment), in
 * order. A step is done when its tenant fact is positive. Malformed facts hide the checklist (fail closed)
 * instead of showing a guess.
 */
export function firstRunChecklist(
  facts: unknown,
  permissions: ReadonlySet<Permission>,
): FirstRunChecklistModel {
  const parsed = firstRunFactsSchema.safeParse(facts);
  if (!parsed.success) return { visible: false, complete: false, steps: [] };

  const steps: FirstRunStep[] = [
    stepFor(
      'verify-asset',
      'Verify an asset',
      parsed.data.verifiedAssetCount > 0,
      '/assets',
      'asset:verify',
      permissions,
    ),
    stepFor(
      'create-sa',
      'Create a standing authorisation',
      parsed.data.activeAuthorisationCount > 0,
      '/authorisations/new',
      'sa:create',
      permissions,
    ),
    stepFor(
      'request-run',
      'Request an assessment',
      parsed.data.requestedRunCount > 0,
      '/assessments/new',
      'run:create',
      permissions,
    ),
  ];

  const complete = steps.every((step) => step.done);
  const canAct = ACTIONABLE.some((permission) => permissions.has(permission));
  return { visible: !complete && canAct, complete, steps };
}

function stepFor(
  id: string,
  label: string,
  done: boolean,
  href: string,
  permission: Permission,
  permissions: ReadonlySet<Permission>,
): FirstRunStep {
  const allowed = permissions.has(permission);
  return {
    id,
    label,
    done,
    ...(allowed ? { href } : {}),
    ...(!allowed && !done ? { disabledReason: CANNOT_ACT } : {}),
  };
}
