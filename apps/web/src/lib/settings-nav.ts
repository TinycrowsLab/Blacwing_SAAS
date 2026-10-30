// Settings sub-navigation (ADMIN-001). Each entry names the permission that reveals it, and the list is
// filtered by the signed-in roles, so an item the member lacks permission for is never rendered. Gating
// is cosmetic: the server re-checks every request (CONTEXT_PACK §8.6, §8.11), and a direct visit to a hidden
// page still gets the permission-denied state.

import { hasPermission } from '@blackwing/domain';

import type { Permission } from '@blackwing/contracts';

export interface SettingsNavEntry {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly requiredPermission: Permission;
}

/** Every settings section, in display order. Pages not built yet still reserve their entry and route. */
export const SETTINGS_NAV_ENTRIES: readonly SettingsNavEntry[] = [
  { key: 'org', label: 'Organisation', href: '/settings/org', requiredPermission: 'settings:read' },
  {
    key: 'members',
    label: 'Members',
    href: '/settings/members',
    requiredPermission: 'member:read',
  },
  { key: 'sso', label: 'SSO', href: '/settings/sso', requiredPermission: 'settings:read' },
  {
    key: 'policies',
    label: 'Policies',
    href: '/settings/policies',
    requiredPermission: 'policy:read',
  },
  {
    key: 'connectors',
    label: 'Connectors',
    href: '/settings/connectors',
    requiredPermission: 'connector:read',
  },
  {
    key: 'secrets',
    label: 'Secrets',
    href: '/settings/secrets',
    requiredPermission: 'secret:read',
  },
  {
    key: 'providers',
    label: 'Providers',
    href: '/settings/providers',
    requiredPermission: 'settings:read',
  },
  {
    key: 'retention',
    label: 'Retention',
    href: '/settings/retention',
    requiredPermission: 'settings:read',
  },
  { key: 'audit', label: 'Audit', href: '/settings/audit', requiredPermission: 'audit:read' },
  { key: 'safety', label: 'Safety', href: '/settings/safety', requiredPermission: 'kill:trigger' },
];

/** The entries `roles` may open, in display order. Unknown or empty roles see none. */
export function visibleSettingsEntries(roles: readonly string[]): readonly SettingsNavEntry[] {
  return SETTINGS_NAV_ENTRIES.filter((entry) => hasPermission(roles, entry.requiredPermission));
}
