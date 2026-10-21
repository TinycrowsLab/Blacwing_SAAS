import { ROLE_PERMISSIONS, ROLES, type Permission, type Role } from '@blackwing/contracts';

/** The primary console lists that can be empty for a new tenant. */
export const EMPTY_STATE_KINDS = ['assets', 'standing-authorisations', 'runs', 'findings'] as const;

export type EmptyStateKind = (typeof EMPTY_STATE_KINDS)[number];

interface EmptyStateSpec {
  readonly title: string;
  readonly description: string;
  /** The next step. Its href is a fixed console route, never built from user input. */
  readonly cta: { readonly label: string; readonly href: string; readonly permission: Permission };
  /** Shown instead of the CTA when the viewer's role cannot take that step. */
  readonly blockedHint: string;
}

const SPECS: Readonly<Record<EmptyStateKind, EmptyStateSpec>> = Object.freeze({
  assets: {
    title: 'No assets yet',
    description: 'Add your first web app, API, host or repository to start authorised testing.',
    cta: { label: 'Add asset', href: '/assets/new', permission: 'asset:write' },
    blockedHint: 'Ask a teammate with asset permissions to register the first asset.',
  },
  'standing-authorisations': {
    title: 'No standing authorisation yet',
    description:
      'A standing authorisation is the signed, expiring approval that lets Blackwing test an asset. Create one before you request an assessment.',
    cta: {
      label: 'Create standing authorisation',
      href: '/authorisations/new',
      permission: 'sa:create',
    },
    blockedHint: 'Ask an asset owner or AppSec engineer to create one for this asset.',
  },
  runs: {
    title: 'No assessments yet',
    description:
      'Request an assessment against a verified asset that has an active standing authorisation.',
    cta: { label: 'Request assessment', href: '/assessments/new', permission: 'run:create' },
    blockedHint: 'Ask an AppSec engineer or developer on your team to request an assessment.',
  },
  findings: {
    title: 'No findings yet',
    description:
      'Findings appear here once an assessment has validated them. Coverage shows which tests ran, even when nothing was confirmed.',
    cta: { label: 'View assessments', href: '/assessments', permission: 'run:read' },
    blockedHint: 'Ask a teammate who can view assessments to share the results.',
  },
});

/** What an empty list shows: copy, the next step if the viewer can take it, and a hint if not. */
export interface ResolvedEmptyState {
  readonly title: string;
  readonly description: string;
  readonly action: { readonly label: string; readonly href: string } | null;
  readonly hint: string | null;
}

/**
 * Resolves the empty state for one list against the viewer's permissions. The CTA is offered only when
 * the viewer holds the permission it needs, so the console never prompts an action the viewer cannot take
 * (the server still enforces it). Pass the permission set from `permissionsForRoles`.
 */
export function emptyStateFor(
  kind: EmptyStateKind,
  permissions: ReadonlySet<Permission>,
): ResolvedEmptyState {
  const spec = SPECS[kind];
  const allowed = permissions.has(spec.cta.permission);
  return {
    title: spec.title,
    description: spec.description,
    action: allowed ? { label: spec.cta.label, href: spec.cta.href } : null,
    hint: allowed ? null : spec.blockedHint,
  };
}

/** The union of the permissions granted by a set of roles. Unknown roles grant nothing. */
export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    if (!(ROLES as readonly string[]).includes(role)) continue;
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}
